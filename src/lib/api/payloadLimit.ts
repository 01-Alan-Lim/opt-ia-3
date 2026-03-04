// src/lib/api/payloadLimit.ts
import { failResponse, type ApiErrorCode } from "@/lib/api/response";

/**
 * Límite simple por bytes del JSON ya parseado (stringify).
 * Esto NO evita que Vercel corte requests gigantes antes de llegar aquí,
 * pero sí:
 *  - protege rutas internas (cuando el payload crece),
 *  - estandariza el error,
 *  - y permite al front mostrar un mensaje humano.
 */
export function assertJsonSizeOrFail(args: {
  value: unknown;
  maxBytes: number; // ej 180_000 (≈180KB)
  code?: ApiErrorCode;
  message?: string;
  status?: number; // 413 recomendado
}) {
  const {
    value,
    maxBytes,
    code = "PAYLOAD_TOO_LARGE",
    message =
      "Tu avance creció demasiado para guardarse en un solo envío. Abriremos un nuevo chat manteniendo tu avance.",
    status = 413,
  } = args;

  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    // si por alguna razón no se puede serializar, lo tratamos como demasiado grande/inválido
    return failResponse(code, "No se pudo serializar el payload.", status);
  }

  if (bytes > maxBytes) {
    return failResponse(code, message, status);
  }

  return null; // OK
}