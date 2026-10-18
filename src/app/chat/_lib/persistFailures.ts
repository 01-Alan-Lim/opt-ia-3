// src/app/chat/_lib/persistFailures.ts
//
// Mensajes que no se pudieron guardar en el historial (R1-E). Lógica pura; el estado lo lleva
// usePersistFailures y el aviso lo pinta PersistFailureNotice.
//
// Un guardado fallido nunca se pierde en silencio: el mensaje sigue visible en el chat, queda
// aquí y se avisa. Tipos de fallo:
//   - temporary: red, 408/425/429 o 5xx (incluye 503 de base sin M2 o sin clave de recibos).
//   - session: 401, la sesión expiró.
//   - rejected: 4xx restantes (recibo inválido o vencido, chat ajeno, sin acceso...). Reintentar
//     no lo arreglaría: se avisa y no se reintenta.
// Mientras un chat tenga mensajes pendientes, los siguientes de ese chat esperan en cola detrás
// para no desordenar el historial (created_at lo pone el servidor al guardar).
//
// Reintentar es manual y manda el mismo cuerpo: la misma clave (user/advisor) o el mismo recibo
// (assistant). El servidor deduplica, así que un reintento nunca crea otro mensaje. Un
// reintento no vuelve a llamar a Gemini.

import type { PersistMessageInput, PersistMessageResult } from "./advisorApi";

export type PersistFailureKind = "temporary" | "session" | "rejected" | "queued";

export type PersistFailure = {
  id: string;
  input: PersistMessageInput;
  kind: PersistFailureKind;
  status: number;
  code: string | null;
};

type FailedResult = Extract<PersistMessageResult, { ok: false }>;

export function classifyPersistFailure(status: number): Exclude<PersistFailureKind, "queued"> {
  if (status === 401) return "session";
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return "temporary";
  return "rejected";
}

export const isPending = (failure: PersistFailure) => failure.kind !== "rejected";

// Clave de idempotencia fija para user y advisor antes del primer intento, para que todos los
// reintentos manden la misma.
export function withClientMessageId(input: PersistMessageInput, newId: () => string): PersistMessageInput {
  if (input.role === "assistant" || input.clientMessageId) return input;
  return { ...input, clientMessageId: newId() };
}

export function blocksChat(list: readonly PersistFailure[], chatId: string): boolean {
  return list.some((failure) => isPending(failure) && failure.input.chatId === chatId);
}

export function recordFailure(
  list: readonly PersistFailure[],
  input: PersistMessageInput,
  result: FailedResult,
  newId: () => string,
): PersistFailure[] {
  return [...list, { id: newId(), input, kind: classifyPersistFailure(result.status), status: result.status, code: result.code }];
}

export function queueBehind(list: readonly PersistFailure[], input: PersistMessageInput, newId: () => string): PersistFailure[] {
  return [...list, { id: newId(), input, kind: "queued", status: 0, code: null }];
}

// Reintenta en orden, un intento por mensaje. En cada chat se detiene en el primer fallo
// pendiente, para no guardar los posteriores antes que él.
export async function retryPending(
  list: readonly PersistFailure[],
  send: (input: PersistMessageInput) => Promise<PersistMessageResult>,
): Promise<PersistFailure[]> {
  const remaining: PersistFailure[] = [];
  const stopped = new Set<string>();

  for (const failure of list) {
    if (!isPending(failure) || stopped.has(failure.input.chatId)) {
      remaining.push(failure);
      continue;
    }
    const result = await send(failure.input);
    if (result.ok) continue;

    const kind = classifyPersistFailure(result.status);
    remaining.push({ ...failure, kind, status: result.status, code: result.code });
    if (kind !== "rejected") stopped.add(failure.input.chatId);
  }

  return remaining;
}

export function dismissRejected(list: readonly PersistFailure[]): PersistFailure[] {
  return list.filter(isPending);
}

export type PersistFailureNoticeModel = {
  pendingText: string | null;
  rejectedText: string | null;
  canRetry: boolean;
  canDismiss: boolean;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function describePersistFailures(list: readonly PersistFailure[]): PersistFailureNoticeModel | null {
  const pending = list.filter(isPending);
  const rejected = list.filter((failure) => !isPending(failure));
  if (pending.length === 0 && rejected.length === 0) return null;

  const session = pending.some((failure) => failure.kind === "session");
  const pendingText = pending.length
    ? `${session ? "Tu sesión expiró. " : ""}${pending.length} ${plural(pending.length, "mensaje no se guardó", "mensajes no se guardaron")} todavía en el historial. ` +
      `${plural(pending.length, "Sigue visible", "Siguen visibles")} aquí, pero si recargas antes de guardarlos no aparecerán.`
    : null;
  const rejectedText = rejected.length
    ? `${rejected.length} ${plural(rejected.length, "mensaje no se pudo guardar", "mensajes no se pudieron guardar")} en el historial: el servidor los rechazó.`
    : null;

  return { pendingText, rejectedText, canRetry: pending.length > 0, canDismiss: rejected.length > 0 };
}
