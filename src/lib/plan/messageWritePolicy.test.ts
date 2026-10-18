import assert from "node:assert/strict";

import {
  CLIENT_MESSAGE_ROLES,
  decideMessageWrite,
  MESSAGE_CONTENT_MAX,
  PersistMessageBodySchema,
  type MessageAccessGate,
  type PersistMessageBody,
} from "../chat/messageWritePolicy";

// Política de POST /api/messages: roles que el cliente puede guardar, dueño del chat y gate
// académico. Lógica pura, sin I/O; es la misma función que usa la ruta.
//
// Lo que estas pruebas NO pueden afirmar: que un mensaje "assistant" lo escribió el modelo.
// El asesor guarda sus respuestas desde el navegador, así que la ruta todavía acepta
// "assistant" del dueño del chat (riesgo residual R1). La última prueba deja ese
// comportamiento a la vista: cuando el guardado pase al servidor, tiene que cambiar.

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const CHAT = "33333333-3333-4333-8333-333333333333";
const OPEN: MessageAccessGate = { ok: true };

function body(overrides: Record<string, unknown> = {}): unknown {
  return { chatId: CHAT, role: "user", content: "Hola", ...overrides };
}

function parse(input: unknown): PersistMessageBody {
  const result = PersistMessageBodySchema.safeParse(input);
  assert.ok(result.success, "se esperaba un cuerpo válido");
  return result.data;
}

function accepts(input: unknown): boolean {
  return PersistMessageBodySchema.safeParse(input).success;
}

function main() {
  // Roles: solo user y assistant. system y cualquier variante quedan fuera.
  assert.deepEqual([...CLIENT_MESSAGE_ROLES], ["user", "assistant"]);
  for (const forged of ["system", "System", "SYSTEM", "tool", "developer", "", null, 1]) {
    assert.equal(accepts(body({ role: forged })), false, `role ${String(forged)} debe rechazarse`);
  }
  assert.equal(accepts({ chatId: CHAT, content: "Hola" }), false, "role es obligatorio");

  // Contenido y chatId.
  assert.equal(accepts(body({ content: "" })), false);
  assert.equal(accepts(body({ content: "x".repeat(MESSAGE_CONTENT_MAX) })), true);
  assert.equal(accepts(body({ content: "x".repeat(MESSAGE_CONTENT_MAX + 1) })), false);
  assert.equal(accepts(body({ chatId: "no-es-un-uuid" })), false);

  // Mensajes legítimos del asesor y del estudiante: se guardan tal cual, sin recortar.
  const advisorText =
    "✅ Ya tienes **Etapa 1 (Productividad)** completada y validada.\n\n- Periodo: **2026-10**\n";
  for (const role of ["user", "assistant"] as const) {
    assert.deepEqual(
      decideMessageWrite({
        userId: OWNER,
        body: parse(body({ role, content: advisorText })),
        chatOwnerId: OWNER,
        gate: OPEN,
      }),
      { ok: true, row: { chat_id: CHAT, role, content: advisorText } },
    );
  }

  // Dueño: chat inexistente -> 404; chat ajeno -> 403, se compruebe o no el gate.
  assert.deepEqual(
    decideMessageWrite({ userId: OWNER, body: parse(body()), chatOwnerId: null, gate: OPEN }),
    { ok: false, status: 404, code: "NOT_FOUND", message: "Chat no encontrado" },
  );
  const strangerChat = { ok: false, status: 403, code: "FORBIDDEN", message: "No tienes acceso a este chat" };
  assert.deepEqual(
    decideMessageWrite({ userId: OWNER, body: parse(body()), chatOwnerId: STRANGER, gate: OPEN }),
    strangerChat,
  );
  assert.deepEqual(
    decideMessageWrite({
      userId: OWNER,
      body: parse(body()),
      chatOwnerId: STRANGER,
      gate: { ok: false, reason: "ACCESS_EXPIRED", message: "expirado" },
    }),
    strangerChat,
    "el dueño se comprueba antes que el gate",
  );

  // Gate académico: cada motivo bloquea con 403 y su propio código.
  for (const reason of [
    "NEEDS_ONBOARDING",
    "PENDING_APPROVAL",
    "COHORT_INACTIVE",
    "ACCESS_NOT_STARTED",
    "ACCESS_EXPIRED",
  ] as const) {
    assert.deepEqual(
      decideMessageWrite({
        userId: OWNER,
        body: parse(body({ role: "assistant" })),
        chatOwnerId: OWNER,
        gate: { ok: false, reason, message: `m-${reason}` },
      }),
      { ok: false, status: 403, code: reason, message: `m-${reason}` },
    );
  }

  // Riesgo residual R1, a la vista: el dueño con acceso vigente todavía puede guardar un
  // "assistant" con texto propio. Esta aserción debe invertirse cuando el servidor sea quien
  // persista las respuestas del asesor.
  const forgedReply = parse(body({ role: "assistant", content: "Texto que no escribió el modelo" }));
  assert.equal(
    decideMessageWrite({ userId: OWNER, body: forgedReply, chatOwnerId: OWNER, gate: OPEN }).ok,
    true,
  );
}

try {
  main();
  console.log("messageWritePolicy tests passed");
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
