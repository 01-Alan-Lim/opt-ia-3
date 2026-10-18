import assert from "node:assert/strict";

import {
  approvedProfile,
  installFetchStub,
  prepareRouteTestEnv,
  routeRequest,
  type RouteStubState,
} from "./assistantRouteHarness";

// Ruta envuelta SIN ASSISTANT_RECEIPT_SECRET (R1, paso 3). Va en su propio archivo porque la
// clave se lee una vez por proceso. La respuesta tiene que salir igual que antes de envolver la
// ruta, sin recibo, y el aviso de que la firma no está disponible sale una sola vez y sin
// valores. Sin red: Supabase y Gemini simulados.

const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "33333333-3333-4333-8333-333333333333";
const COHORT = "66666666-6666-4666-8666-666666666666";

const state: RouteStubState = {
  user: { id: USER, email: "ana.prueba@estudiante.test" },
  profile: approvedProfile(USER, COHORT),
  cohortActive: true,
  chatOwners: { [CHAT]: USER },
  artifact: { payload: { activities: [] }, chat_id: CHAT, period_key: "2026-10", updated_at: "2026-10-10T12:00:00Z" },
  geminiReplies: [],
};

const progressState = {
  step: "intro",
  reportText: null,
  progressPercent: null,
  measurementNote: null,
  summary: null,
  updatedAtLocal: null,
};

async function main() {
  prepareRouteTestEnv();
  const stub = installFetchStub(state);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    const progress = await import("../../app/api/plans/progress/assistant/route");
    for (let i = 0; i < 2; i++) {
      const res = await progress.POST(
        routeRequest("/api/plans/progress/assistant", { chatId: CHAT, studentMessage: "ok", progressState }),
      );
      assert.equal(res.status, 200);
      const json = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
      assert.equal(json.ok, true);
      assert.deepEqual(Object.keys(json.data), ["assistantMessage", "updates"], "sin recibo y sin campos nuevos");
    }
  } finally {
    console.warn = originalWarn;
  }

  const receiptWarnings = warnings.filter((w) => w.includes("[assistant-receipt]"));
  assert.equal(receiptWarnings.length, 1, "el aviso sale una sola vez");
  assert.match(receiptWarnings[0], /ASSISTANT_RECEIPT_SECRET no disponible \(MISSING\)/);
  assert.equal(stub.geminiCalls(), 0);
  assert.equal(stub.writes.length, 0);
  stub.restore();
}

main()
  .then(() => console.log("assistantRouteReceiptsNoKey tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
