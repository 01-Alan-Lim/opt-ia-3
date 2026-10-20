import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

import { PLAN_CONTINUES_NOTICE, planChatEntry, sidebarChats } from "../../app/chat/_lib/planChatClient";
import { approvedProfile, prepareRouteTestEnv, routeRequest } from "./assistantRouteHarness";
import { installRestStub, nextTimestamp, type RestRow, type RestStubState } from "./restStubHarness";

// Chat principal del Plan de Mejora (src/lib/plan/planChat.ts) a través de las rutas reales
// GET/POST /api/plans/context, contra un Supabase simulado en memoria: sin red y sin Production.
// Cada estudiante trabaja su plan en un solo chat del asesor: se reutiliza al pedir otro chat, desde
// otra pestaña o tras recargar; con chats históricos manda el chat donde está el avance; nunca se
// usa el chat de otro estudiante. Al final, las decisiones del navegador (planChatClient.ts).

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const COHORT = "88888888-8888-4888-8888-888888888888";
const ANA = { id: USER, email: "ana.prueba@estudiante.test" };
const BETO = { id: OTHER, email: "beto.prueba@estudiante.test" };

const state: RestStubState = {
  user: ANA,
  tables: {},
  uniques: { plan_case_contexts: [{ name: "plan_case_contexts_user_id_uniq", columns: ["user_id"] }] },
  defaults: { chats: () => ({ id: crypto.randomUUID(), title: null, hidden: false, pinned: false, created_at: nextTimestamp() }) },
};

type Json = Record<string, unknown>;

const chat = (id: string, clientId: string, mode = "plan_mejora", extra: RestRow = {}): RestRow => ({
  id,
  client_id: clientId,
  title: "Asesor - Contexto del Caso",
  mode,
  hidden: false,
  pinned: false,
  created_at: nextTimestamp(),
  ...extra,
});
const context = (userId: string, chatId: string | null, status = "draft", json: Json = {}): RestRow => ({
  id: crypto.randomUUID(),
  user_id: userId,
  chat_id: chatId,
  status,
  version: 1,
  context_json: json,
  context_text: null,
});
const stageState = (userId: string, chatId: string, stage: number): RestRow => ({
  id: crypto.randomUUID(),
  user_id: userId,
  chat_id: chatId,
  stage,
  state_json: { stage },
  updated_at: nextTimestamp(),
});

function seed(tables: Record<string, RestRow[]> = {}, profileOverride: Json = {}) {
  state.user = ANA;
  state.tables = {
    profiles: [
      { ...approvedProfile(USER, COHORT), email: ANA.email, ...profileOverride },
      { ...approvedProfile(OTHER, COHORT), email: BETO.email },
    ],
    cohorts: [{ id: COHORT, is_active: true }],
    chats: [],
    plan_case_contexts: [],
    plan_stage_states: [],
    ...tables,
  };
}

const advisorChatsOf = (userId: string) =>
  (state.tables.chats ?? []).filter((c) => c.client_id === userId && c.mode === "plan_mejora");
const contextOf = (userId: string) => (state.tables.plan_case_contexts ?? []).find((r) => r.user_id === userId);

async function main() {
  prepareRouteTestEnv({ ALLOWED_EMAIL_DOMAIN: "estudiante.test" });
  const stub = installRestStub(state);
  const route = await import("../../app/api/plans/context/route");
  const { claimPlanChat } = await import("./planChat");

  async function get() {
    const res = await route.GET(
      new NextRequest("https://opt-ia.test/api/plans/context", { headers: { authorization: "Bearer token-de-prueba" } })
    );
    return { status: res.status, data: ((await res.json()) as Json).data as Json | undefined };
  }
  async function post(body: Json) {
    const res = await route.POST(routeRequest("/api/plans/context", body));
    return { status: res.status, data: ((await res.json()) as Json).data as Json | undefined };
  }
  const askChat = () => post({ forceNew: true, contextJson: {}, contextText: null });

  // ---------------- 1. Primer acceso: GET no crea nada; pedir chat crea el primero ----------------
  {
    seed();
    stub.reset();
    const first = await get();
    assert.equal(first.status, 200);
    assert.equal(first.data?.chatId, null);
    assert.equal(first.data?.exists, false);
    assert.equal(stub.writes("chats") + stub.writes("plan_case_contexts"), 0, "leer no crea nada");

    const created = await askChat();
    assert.equal(created.status, 200);
    const planChatId = String(created.data?.chatId);
    assert.equal(advisorChatsOf(USER).length, 1);
    assert.equal(advisorChatsOf(USER)[0]?.id, planChatId);
    assert.equal(contextOf(USER)?.chat_id, planChatId);
    assert.equal(contextOf(USER)?.status, "draft");

    // ---------------- 2 y 4. Reingreso y "Nuevo chat" repetido: siempre el mismo chat ----------------
    for (let i = 0; i < 3; i++) {
      const again = await askChat();
      assert.equal(again.data?.chatId, planChatId, `pedido ${i + 1}`);
    }
    assert.equal(advisorChatsOf(USER).length, 1, "no se crean chats adicionales");

    // ---------------- 6. Recarga / otra pestaña / otra sesión: GET devuelve el mismo chat ----------------
    stub.reset();
    for (let i = 0; i < 2; i++) assert.equal((await get()).data?.chatId, planChatId);
    assert.equal(stub.writes("chats") + stub.writes("plan_case_contexts"), 0);

    // ---------------- 3 y 5. Un chat del Asistente General no toca el plan ----------------
    // (lo crea /api/chat; aquí se agrega como lo dejaría esa ruta)
    const generalChatId = crypto.randomUUID();
    state.tables.chats?.push(chat(generalChatId, USER, "general"));
    assert.equal((await get()).data?.chatId, planChatId);
    // Guardar E0 con el chat del otro modo (cambio rápido de modo) no mueve el plan a ese chat.
    const saved = await post({ contextJson: { sector: "Panadería" }, contextText: "Sector/Rubro: Panadería", chatId: generalChatId });
    assert.equal(saved.status, 200);
    assert.equal(saved.data?.chatId, planChatId);
    assert.equal(contextOf(USER)?.chat_id, planChatId);
    assert.deepEqual(contextOf(USER)?.context_json, { sector: "Panadería" });
    assert.equal(state.tables.chats?.find((c) => c.id === generalChatId)?.mode, "general");
  }

  // ---------------- 7. E0 confirmado: pedir chat no reinicia ni modifica el contexto ----------------
  {
    const planChatId = crypto.randomUUID();
    const confirmedJson = { sector: "Alimentos", products: ["Yogur"], process_focus: ["Producción"] };
    seed({ chats: [chat(planChatId, USER)], plan_case_contexts: [context(USER, planChatId, "confirmed", confirmedJson)] });
    stub.reset();
    const reused = await askChat();
    assert.equal(reused.data?.chatId, planChatId);
    assert.equal(reused.data?.status, "confirmed");
    assert.deepEqual(reused.data?.contextJson, confirmedJson);
    assert.equal(stub.writes("plan_case_contexts") + stub.writes("chats"), 0);
    // forceNew con datos ya no vuelve el contexto a borrador ni lo limpia (antes: reinicio de E0).
    const edited = await post({ forceNew: true, contextJson: { sector: "Lácteos" }, contextText: "Sector/Rubro: Lácteos" });
    assert.equal(edited.status, 200);
    assert.equal(contextOf(USER)?.status, "confirmed");
    assert.deepEqual(contextOf(USER)?.context_json, { ...confirmedJson, sector: "Lácteos" });
    assert.equal(advisorChatsOf(USER).length, 1);
  }

  // ---------------- 8. E1-E10 con avance en el chat del plan ----------------
  {
    const planChatId = crypto.randomUUID();
    seed({
      chats: [chat(planChatId, USER)],
      plan_case_contexts: [context(USER, planChatId, "confirmed")],
      plan_stage_states: [stageState(USER, planChatId, 2), stageState(USER, planChatId, 3), stageState(USER, planChatId, 4)],
    });
    stub.reset();
    assert.equal((await get()).data?.chatId, planChatId);
    assert.equal((await askChat()).data?.chatId, planChatId);
    assert.equal(stub.writes("plan_stage_states") + stub.writes("plan_case_contexts") + stub.writes("chats"), 0);
  }

  // ---------------- 9. Chats históricos: manda el chat del avance, sin migrar nada ----------------
  {
    const oldChat = crypto.randomUUID();
    const progressChat = crypto.randomUUID();
    const generalChat = crypto.randomUUID();
    const foreignChat = crypto.randomUUID();
    const states = () => [stageState(USER, oldChat, 2), stageState(USER, progressChat, 3)];

    // a) El último estado está en otro chat del asesor: ese es el del plan. Nada se escribe.
    seed({
      chats: [chat(oldChat, USER), chat(progressChat, USER)],
      plan_case_contexts: [context(USER, oldChat, "confirmed")],
      plan_stage_states: states(),
    });
    const statesBefore = JSON.stringify(state.tables.plan_stage_states);
    stub.reset();
    assert.equal((await get()).data?.chatId, progressChat);
    assert.equal((await askChat()).data?.chatId, progressChat, "pedir chat tampoco crea ni mueve");
    assert.equal(stub.writes("plan_stage_states") + stub.writes("plan_case_contexts") + stub.writes("chats"), 0);
    assert.equal(JSON.stringify(state.tables.plan_stage_states), statesBefore, "los estados históricos quedan intactos");
    assert.equal(contextOf(USER)?.chat_id, oldChat, "no se reasigna");

    // b) Un estado guardado en un chat del Asistente General no convierte ese chat en el del plan.
    seed({
      chats: [chat(oldChat, USER), chat(generalChat, USER, "general")],
      plan_case_contexts: [context(USER, oldChat, "confirmed")],
      plan_stage_states: [stageState(USER, oldChat, 2), stageState(USER, generalChat, 3)],
    });
    assert.equal((await get()).data?.chatId, oldChat);

    // c) Ni un chat de otro estudiante.
    seed({
      chats: [chat(oldChat, USER), chat(foreignChat, OTHER)],
      plan_case_contexts: [context(USER, oldChat, "confirmed")],
      plan_stage_states: [stageState(USER, oldChat, 2), stageState(USER, foreignChat, 3)],
    });
    assert.equal((await get()).data?.chatId, oldChat);

    // d) Un chat del plan oculto desde la barra lateral sigue siendo el del plan.
    seed({ chats: [chat(oldChat, USER, "plan_mejora", { hidden: true })], plan_case_contexts: [context(USER, oldChat)] });
    assert.equal((await get()).data?.chatId, oldChat);
    assert.equal((await askChat()).data?.chatId, oldChat);
    assert.equal(advisorChatsOf(USER).length, 1);
  }

  // ---------------- 10. Entre estudiantes: nunca el chat de otro ----------------
  {
    const anaChat = crypto.randomUUID();
    seed({ chats: [chat(anaChat, USER)], plan_case_contexts: [context(USER, anaChat, "draft", { sector: "Panadería" })] });
    state.user = BETO;
    stub.reset();
    assert.equal((await get()).data?.chatId, null, "Beto no ve el chat de Ana");
    const forged = await post({ contextJson: { sector: "Textil" }, contextText: "x", chatId: anaChat });
    assert.equal(forged.status, 403);
    assert.equal(stub.writes("plan_case_contexts") + stub.writes("chats"), 0);
    assert.deepEqual(contextOf(USER)?.context_json, { sector: "Panadería" });

    // Una fila de Beto que apunta al chat de Ana (dato corrupto) no se usa: Beto recibe el suyo.
    state.tables.plan_case_contexts?.push(context(OTHER, anaChat));
    const own = await askChat();
    assert.equal(own.status, 200);
    assert.notEqual(own.data?.chatId, anaChat);
    assert.equal(advisorChatsOf(OTHER).length, 1);
    assert.equal(contextOf(OTHER)?.chat_id, own.data?.chatId);
    assert.equal(contextOf(USER)?.chat_id, anaChat, "el plan de Ana no cambia");
    assert.equal(state.tables.chats?.find((c) => c.id === anaChat)?.client_id, USER);
  }

  // ---------------- 11. Peticiones simultáneas para crear el plan ----------------
  {
    seed();
    const [a, b] = await Promise.all([askChat(), askChat()]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.data?.chatId, b.data?.chatId, "las dos reciben el mismo chat del plan");
    const visible = advisorChatsOf(USER).filter((c) => !c.hidden);
    assert.equal(visible.length, 1, "un solo chat del asesor visible");
    assert.equal(visible[0]?.id, a.data?.chatId);
    assert.ok(advisorChatsOf(USER).length <= 2);
    assert.equal(contextOf(USER)?.chat_id, a.data?.chatId);
    assert.equal((state.tables.plan_case_contexts ?? []).filter((r) => r.user_id === USER).length, 1);

    // La petición que pierde (determinista): leyó "sin chat", otra ya asignó uno. Devuelve el del
    // plan y oculta el chat vacío que había creado; no borra nada.
    const winner = crypto.randomUUID();
    seed({ chats: [chat(winner, USER)], plan_case_contexts: [context(USER, winner)] });
    const lost = await claimPlanChat(USER, null);
    assert.deepEqual(lost, { ok: true, chatId: winner, created: false });
    const extra = advisorChatsOf(USER).filter((c) => c.id !== winner);
    assert.equal(extra.length, 1);
    assert.equal(extra[0]?.hidden, true);

    // Si lo que perdió era un chat que ya existía (el candidato), no se oculta: no lo creó.
    const candidate = crypto.randomUUID();
    seed({ chats: [chat(winner, USER), chat(candidate, USER)], plan_case_contexts: [context(USER, winner)] });
    assert.deepEqual(await claimPlanChat(USER, null, candidate), { ok: true, chatId: winner, created: false });
    assert.equal(state.tables.chats?.find((c) => c.id === candidate)?.hidden, false);
  }

  // ---------------- 12. Gates académicos intactos ----------------
  {
    for (const blocked of [{ registration_status: "pending" }, { ru: null }]) {
      seed({}, blocked);
      stub.reset();
      assert.equal((await get()).status, 403, JSON.stringify(blocked));
      assert.equal((await askChat()).status, 403, JSON.stringify(blocked));
      assert.equal(stub.writes("chats") + stub.writes("plan_case_contexts"), 0);
    }
    seed();
    state.tables.cohorts = [{ id: COHORT, is_active: false }];
    assert.equal((await askChat()).status, 403, "cohorte inactiva");
    assert.equal(advisorChatsOf(USER).length, 0);

    // Guardar E0 nunca confirma: eso sigue siendo /api/plans/context/confirm.
    seed();
    await post({ contextJson: { sector: "Alimentos", products: ["Yogur"], process_focus: ["Producción"] }, contextText: "x" });
    assert.equal(contextOf(USER)?.status, "draft");
  }

  // ---------------- Navegador: decisiones de planChatClient.ts ----------------
  {
    const plan = "plan-chat";
    // Recarga en el chat del plan, o "Nuevo chat" estando en él: no se toca nada.
    assert.deepEqual(planChatEntry({ storedAdvisorChatId: plan, currentChatId: plan, planChatId: plan }), {
      adopt: false,
      clearMessages: false,
    });
    // Cambio rápido desde el Asistente General: el chat activo era el general; la pestaña ya tenía
    // el del plan (su historial se está cargando), así que se adopta sin borrar la pantalla.
    assert.deepEqual(planChatEntry({ storedAdvisorChatId: plan, currentChatId: "general-chat", planChatId: plan }), {
      adopt: true,
      clearMessages: false,
    });
    // La pestaña guardaba un chat histórico del asesor: se limpia y se abre el del plan.
    assert.deepEqual(planChatEntry({ storedAdvisorChatId: "old-chat", currentChatId: "old-chat", planChatId: plan }), {
      adopt: true,
      clearMessages: true,
    });
    // Pestaña nueva u otra sesión: nada guardado.
    assert.deepEqual(planChatEntry({ storedAdvisorChatId: null, currentChatId: null, planChatId: plan }), {
      adopt: true,
      clearMessages: true,
    });

    // Barra lateral: chats generales y, del asesor, solo el del plan (agregado si estaba oculto).
    const list = [
      { id: "g1", mode: "general" },
      { id: "old", mode: "plan_mejora" },
      { id: plan, mode: "plan_mejora" },
      { id: "g2", mode: "general" },
    ];
    const entry = (id: string) => ({ id, mode: "plan_mejora" });
    assert.deepEqual(sidebarChats(list, plan, entry).map((c) => c.id), ["g1", plan, "g2"]);
    assert.deepEqual(sidebarChats([{ id: "g1", mode: "general" }], plan, entry).map((c) => c.id), [plan, "g1"]);
    // Sin chat del plan informado (solo lectura): la lista queda como estaba.
    assert.deepEqual(sidebarChats(list, null, entry), list);
    assert.ok(!PLAN_CONTINUES_NOTICE.includes("¿"), "el aviso no hace otra pregunta");

    // El navegador ya no marca "plan nuevo" ni borra el chat del asesor al abrir un chat general, y
    // ninguna ruta crea chats del asesor por su cuenta (solo planChat.ts).
    const page = readFileSync(path.join("src", "app", "chat", "page.tsx"), "utf8");
    assert.ok(!/PlanFresh|optia-plan-fresh/.test(page));
    assert.ok(!/removeItem\(`optia-chat-id-\$\{clientId\}-plan_mejora`\)/.test(page));
    for (const file of [
      path.join("src", "app", "api", "plans", "context", "route.ts"),
      path.join("src", "app", "api", "plans", "review", "route.ts"),
    ]) {
      assert.ok(!/from\("chats"\)\s*\.insert/.test(readFileSync(file, "utf8")), file);
    }
  }

  stub.restore();
  console.log("planChat tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
