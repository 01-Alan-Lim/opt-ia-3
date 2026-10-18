import assert from "node:assert/strict";

import { approvedProfile, prepareRouteTestEnv, routeRequest } from "./assistantRouteHarness";
import { installMessageStub, type MessageStubState } from "./messageRouteHarness";

// POST /api/messages SIN ASSISTANT_RECEIPT_SECRET (R1). En su propio archivo porque la clave se
// lee una vez por proceso. Ninguna respuesta assistant se puede verificar: 503 y nada guardado,
// con un único aviso sin valores. user y advisor (los textos locales) se siguen guardando, así
// que la conversación no se pierde. Sin red: Supabase simulado.

const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "33333333-3333-4333-8333-333333333333";

const state: MessageStubState = {
  user: { id: USER, email: "ana.prueba@estudiante.test" },
  profile: approvedProfile(USER, "88888888-8888-4888-8888-888888888888"),
  cohortActive: true,
  chats: { [CHAT]: { client_id: USER, mode: "plan_mejora" } },
  messages: [],
  schema: "m2",
  contexts: {},
};

async function main() {
  prepareRouteTestEnv();
  const stub = installMessageStub(state);
  const route = await import("../../app/api/messages/route");

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    for (let i = 0; i < 2; i++) {
      const res = await route.POST(
        routeRequest("/api/messages", {
          chatId: CHAT,
          role: "assistant",
          serverReply: { assistantMessage: "Texto del servidor", assistantReceipt: "ar1.cualquier.cosa" },
        }),
      );
      assert.equal(res.status, 503);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.code, "RECEIPT_KEY_UNAVAILABLE");
      assert.ok(!String(body.message).includes("ASSISTANT_RECEIPT_SECRET="), "sin valores");
    }
    assert.equal(state.messages.length, 0, "ninguna respuesta assistant sin verificar");

    for (const role of ["user", "advisor"]) {
      const res = await route.POST(routeRequest("/api/messages", { chatId: CHAT, role, content: `Texto ${role}` }));
      assert.equal(res.status, 200, `${role} se sigue guardando`);
    }
    assert.deepEqual(state.messages.map((m) => m.role), ["user", "advisor"]);
  } finally {
    console.warn = originalWarn;
  }

  const keyWarnings = warnings.filter((w) => w.includes("[messages]"));
  assert.equal(keyWarnings.length, 1, "un solo aviso");
  assert.match(keyWarnings[0], /ASSISTANT_RECEIPT_SECRET no disponible \(MISSING\)/);
  stub.restore();
}

main()
  .then(() => console.log("messagesRouteNoKey tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
