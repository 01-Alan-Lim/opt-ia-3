import assert from "node:assert/strict";

import { prepareRouteTestEnv } from "./assistantRouteHarness";
import { installRestStub, type RestRow, type RestStubState } from "./restStubHarness";
import { vectorNorm } from "../embeddingEngine";
import type { AcademicRagOutcome } from "../chat/academicRag";

// academicRag carga supabaseServer y el motor de embeddings, que leen el entorno al cargarse: se
// importa después de prepareRouteTestEnv.
type Rag = typeof import("../chat/academicRag");

// RAG de la Biblioteca Académica para /api/chat (src/lib/chat/academicRag.ts) con Supabase y
// Gemini simulados (sin red). Las RPC de M6 se simulan con los mismos filtros del SQL; el SQL en
// sí se prueba en supabase/tests/m6_academic_rag.pglite.mjs. Comprueba qué documentos llegan,
// con qué parámetros se busca, qué pasa sin material o con errores, y que la RPC antigua sin
// filtros nunca se usa.

const CURRENT = "gemini-embedding-001:768";
const DIM = 768;
type Json = Record<string, unknown>;

const STUDENT_A = { id: "20000000-0000-4000-8000-00000000000a", email: "ana@umsa.bo" };
const STUDENT_B = { id: "20000000-0000-4000-8000-00000000000b", email: "beto@umsa.bo" };
const QUESTION = "¿Cómo se calcula la eficiencia en el balanceo de línea?";

// El mismo vector que devuelve el Gemini simulado, normalizado como lo deja el motor.
function fakeVector(text: string): number[] {
  let seed = 0;
  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) % 9973;
  return Array.from({ length: DIM }, (_, k) => ((seed + k * 7) % 13) - 6 + 0.25);
}
const unit = (values: number[]) => {
  const norm = vectorNorm(values);
  return values.map((v) => v / norm);
};
const QUERY_VECTOR = unit(fakeVector(QUESTION));
const SIMILAR = QUERY_VECTOR;
const OPPOSITE = QUERY_VECTOR.map((v) => -v);
const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);

// ---------------- Datos ----------------

function doc(id: string, extra: RestRow): RestRow {
  return { id, title: id, path: `library/${id}.pdf`, user_id: null, file_type: "pdf", status: "ready", is_active: true, ...extra };
}
let chunkId = 0;
function chunk(documentId: string, content: string, embedding: number[], model = CURRENT): RestRow {
  return { id: ++chunkId, document_id: documentId, chunk_index: chunkId, content, embedding, embedding_model: model };
}

const state: RestStubState = {
  user: null,
  tables: {
    documents: [
      doc("global-listo", {}),
      doc("global-inactivo", { is_active: false }),
      doc("global-procesando", { status: "processing" }),
      doc("global-pendiente", { status: "pending" }),
      doc("global-fallido", { status: "failed" }),
      doc("guia-legacy", { path: "mypes/guia.pdf", status: "pending" }),
      doc("guia-legacy-lista", { path: "mypes/guia2.pdf" }),
      doc("demo", { path: "demo/opt-ia-demo.txt", file_type: "txt", status: "pending", is_active: false }),
      doc("propio-a", { user_id: STUDENT_A.id }),
      doc("propio-b", { user_id: STUDENT_B.id }),
    ],
    document_chunks: [
      chunk("global-listo", "Eficiencia = suma de tiempos / (estaciones × ciclo).", SIMILAR),
      chunk("global-listo", "Texto sin relación con la pregunta.", OPPOSITE),
      chunk("global-inactivo", "INACTIVO", SIMILAR),
      chunk("global-procesando", "PROCESANDO", SIMILAR),
      chunk("global-pendiente", "PENDIENTE", SIMILAR),
      chunk("global-fallido", "FALLIDO", SIMILAR),
      chunk("guia-legacy", "LEGACY", SIMILAR, "legacy-768"),
      chunk("guia-legacy-lista", "LEGACY LISTA", SIMILAR, "legacy-768"),
      chunk("demo", "ATO Fase 1: rutina CIL", SIMILAR, "legacy-768"),
      chunk("propio-a", "Apunte propio de A.", SIMILAR),
      chunk("propio-b", "Apunte propio de B.", SIMILAR),
    ],
  },
};

// ---------------- Simulación de M6 (mismos filtros que el SQL) ----------------

const MODEL_FORMAT = /^[a-z0-9][a-z0-9._-]*:[1-9][0-9]*$/;
const rpcCalls: Array<{ name: string; args: Json }> = [];
let rpcFailure: Partial<Record<string, { status: number; code: string; message: string }>> = {};
let rowsOverride: unknown = null;

function eligible(args: Json): RestRow[] {
  const model = args.p_embedding_model as string;
  const userId = (args.p_user_id as string | null | undefined) ?? null;
  const docsById = new Map(state.tables.documents.map((d) => [d.id, d]));
  return state.tables.document_chunks.filter((c) => {
    const d = docsById.get(c.document_id);
    return (
      d !== undefined &&
      d.is_active === true &&
      d.status === "ready" &&
      (d.user_id === null || (userId !== null && d.user_id === userId)) &&
      c.embedding_model === model &&
      Array.isArray(c.embedding)
    );
  });
}

function rpcHandler(name: string, run: (args: Json) => unknown) {
  return (args: Json) => {
    rpcCalls.push({ name, args });
    const failure = rpcFailure[name];
    if (failure) return { error: failure };
    return { data: run(args) };
  };
}

state.rpc = {
  academic_library_available: rpcHandler("academic_library_available", (args) =>
    args.p_embedding_model !== "legacy-768" && eligible(args).length > 0
  ),
  match_academic_chunks: rpcHandler("match_academic_chunks", (args) => {
    const model = String(args.p_embedding_model);
    if (model === "legacy-768" || !MODEL_FORMAT.test(model)) throw new Error("el módulo no debe pedir ese modelo");
    if (rowsOverride !== null) return rowsOverride;
    const query = args.query_embedding as number[];
    const count = Number(args.match_count);
    const min = Number(args.p_min_similarity ?? 0);
    return eligible(args)
      .map((c) => ({ id: c.id, document_id: c.document_id, chunk_index: c.chunk_index, content: c.content, similarity: dot(c.embedding as number[], query) }))
      .filter((row) => row.similarity >= min)
      .sort((a, b) => b.similarity - a.similarity || Number(a.id) - Number(b.id))
      .slice(0, Math.min(count, 20));
  }),
  // La RPC antigua, sin filtros: si alguien la llama, la prueba lo ve.
  match_document_chunks: rpcHandler("match_document_chunks", () => state.tables.document_chunks.map((c) => ({ content: c.content }))),
};

// ---------------- Gemini simulado ----------------

type GeminiMode = "ok" | "rate" | "dim3072";
const gemini = { mode: "ok" as GeminiMode, requests: [] as Json[] };

async function geminiEndpoint(req: Request, url: URL): Promise<Response | null> {
  if (url.host !== "generativelanguage.googleapis.com") return null;
  const body = (await req.json()) as Json;
  gemini.requests.push(body);
  const respond = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  if (gemini.mode === "rate") return respond({ error: { code: 429, message: "Resource has been exhausted" } }, 429);
  const text = ((body.content as { parts?: Array<{ text?: string }> }).parts ?? []).map((p) => p.text ?? "").join("");
  const values = gemini.mode === "dim3072" ? Array.from({ length: 3072 }, () => 0.5) : fakeVector(text);
  return respond({ embedding: { values } });
}

function runConfig({ readAcademicRagConfig, academicPromptSection, DEFAULT_MATCH_COUNT, DEFAULT_MIN_SIMILARITY, MAX_MATCH_COUNT }: Rag) {
  assert.deepEqual(readAcademicRagConfig({}), { matchCount: DEFAULT_MATCH_COUNT, minSimilarity: DEFAULT_MIN_SIMILARITY });
  assert.equal(readAcademicRagConfig({ ACADEMIC_RAG_MATCH_COUNT: "3" }).matchCount, 3);
  assert.equal(readAcademicRagConfig({ ACADEMIC_RAG_MATCH_COUNT: "0" }).matchCount, 0, "0 apaga la búsqueda");
  assert.equal(readAcademicRagConfig({ ACADEMIC_RAG_MATCH_COUNT: "50" }).matchCount, MAX_MATCH_COUNT);
  assert.equal(readAcademicRagConfig({ ACADEMIC_RAG_MATCH_COUNT: "-2" }).matchCount, 0);
  assert.equal(readAcademicRagConfig({ ACADEMIC_RAG_MATCH_COUNT: "2.5" }).matchCount, DEFAULT_MATCH_COUNT);
  assert.equal(readAcademicRagConfig({ ACADEMIC_RAG_MATCH_COUNT: "abc" }).matchCount, DEFAULT_MATCH_COUNT);
  assert.equal(readAcademicRagConfig({ ACADEMIC_RAG_MIN_SIMILARITY: "0.7" }).minSimilarity, 0.7);
  assert.equal(readAcademicRagConfig({ ACADEMIC_RAG_MIN_SIMILARITY: "3" }).minSimilarity, 1);
  assert.equal(readAcademicRagConfig({ ACADEMIC_RAG_MIN_SIMILARITY: "x" }).minSimilarity, DEFAULT_MIN_SIMILARITY);

  // El bloque del prompt: numerado, solo el texto (sin títulos ni rutas).
  assert.equal(academicPromptSection(["Primero.", "Segundo."]), "(1) Primero.\n(2) Segundo.");
}

async function runRetrieval({ retrieveAcademicContext }: Rag) {
  const stub = installRestStub(state, geminiEndpoint);
  const config = { matchCount: 5, minSimilarity: 0.5 };
  const oldRpcCalls = () => rpcCalls.filter((c) => c.name === "match_document_chunks").length;
  const reset = () => {
    rpcCalls.length = 0;
    gemini.requests.length = 0;
    gemini.mode = "ok";
    rpcFailure = {};
    rowsOverride = null;
  };
  const chunksOf = (outcome: AcademicRagOutcome) => (outcome.status === "used" ? outcome.chunks : []);

  try {
    {
      // Estudiante A: el documento global activo y listo y su propio documento; nada inactivo,
      // pendiente, procesando, fallido, legacy, demo ni de otro estudiante.
      reset();
      const outcome = await retrieveAcademicContext({ userId: STUDENT_A.id, question: QUESTION, config });
      assert.equal(outcome.status, "used");
      assert.deepEqual(chunksOf(outcome).sort(), ["Apunte propio de A.", "Eficiencia = suma de tiempos / (estaciones × ciclo)."]);

      // La consulta: availability y búsqueda con el usuario de la ruta, el modelo del motor y la
      // configuración; la pregunta embebida con RETRIEVAL_QUERY y 768 dimensiones normalizadas.
      assert.deepEqual(rpcCalls.map((c) => c.name), ["academic_library_available", "match_academic_chunks"]);
      assert.deepEqual(rpcCalls[0].args, { p_embedding_model: CURRENT, p_user_id: STUDENT_A.id });
      const search = rpcCalls[1].args;
      assert.equal(search.p_user_id, STUDENT_A.id);
      assert.equal(search.p_embedding_model, CURRENT);
      assert.equal(search.match_count, 5);
      assert.equal(search.p_min_similarity, 0.5);
      const queryEmbedding = search.query_embedding as number[];
      assert.equal(queryEmbedding.length, DIM);
      assert.ok(Math.abs(vectorNorm(queryEmbedding) - 1) < 1e-9);
      assert.equal(gemini.requests.length, 1);
      assert.equal(gemini.requests[0].taskType, "RETRIEVAL_QUERY");
      assert.equal(gemini.requests[0].outputDimensionality, DIM);
    }
    {
      // Aislamiento: B ve lo suyo y lo global, nunca lo de A.
      reset();
      const outcome = await retrieveAcademicContext({ userId: STUDENT_B.id, question: QUESTION, config });
      assert.deepEqual(chunksOf(outcome).sort(), ["Apunte propio de B.", "Eficiencia = suma de tiempos / (estaciones × ciclo)."]);
    }
    {
      // Cantidad configurable: con 1 fragmento, solo el más parecido.
      reset();
      const outcome = await retrieveAcademicContext({ userId: STUDENT_A.id, question: QUESTION, config: { matchCount: 1, minSimilarity: 0.5 } });
      assert.equal(chunksOf(outcome).length, 1);
      assert.equal(rpcCalls[1].args.match_count, 1);
      // El umbral llega a la búsqueda: el fragmento opuesto (similitud -1) queda fuera.
      reset();
      const loose = await retrieveAcademicContext({ userId: STUDENT_A.id, question: QUESTION, config: { matchCount: 5, minSimilarity: 0 } });
      assert.equal(rpcCalls[1].args.p_min_similarity, 0);
      assert.ok(!chunksOf(loose).includes("Texto sin relación con la pregunta."));
      // Hay biblioteca pero nada parecido: no_match (sin material en el prompt).
      reset();
      rowsOverride = [];
      assert.equal((await retrieveAcademicContext({ userId: STUDENT_A.id, question: QUESTION, config })).status, "no_match");
    }
    {
      // Búsqueda apagada o sin pregunta: ni RPC ni Gemini.
      reset();
      assert.equal((await retrieveAcademicContext({ userId: STUDENT_A.id, question: QUESTION, config: { matchCount: 0, minSimilarity: 0.5 } })).status, "disabled");
      assert.equal((await retrieveAcademicContext({ userId: STUDENT_A.id, question: "   ", config })).status, "disabled");
      assert.equal(rpcCalls.length + gemini.requests.length, 0);
    }
    {
      // Sin documentos compatibles (solo legacy, inactivos, pendientes o fallidos): no se llama a
      // Gemini ni a la búsqueda, y el asistente responde con su conocimiento general.
      reset();
      const saved = state.tables.documents.map((d) => ({ ...d }));
      for (const d of state.tables.documents) {
        if (d.id === "global-listo" || d.id === "propio-a" || d.id === "propio-b") d.is_active = false;
      }
      const outcome = await retrieveAcademicContext({ userId: STUDENT_A.id, question: QUESTION, config });
      state.tables.documents = saved;
      assert.equal(outcome.status, "no_library");
      assert.deepEqual(rpcCalls.map((c) => c.name), ["academic_library_available"]);
      assert.equal(gemini.requests.length, 0);
    }
    {
      // Errores de las RPC (incluida M6 sin aplicar: la función no existe): sin respaldo en la
      // RPC antigua y sin material.
      for (const [name, failure] of [
        ["academic_library_available", { status: 404, code: "PGRST202", message: "Could not find the function" }],
        ["academic_library_available", { status: 500, code: "XX000", message: "boom" }],
        ["match_academic_chunks", { status: 404, code: "PGRST202", message: "Could not find the function" }],
        ["match_academic_chunks", { status: 400, code: "22023", message: "modelo de embedding no admitido" }],
      ] as const) {
        reset();
        rpcFailure = { [name]: failure };
        const outcome = await retrieveAcademicContext({ userId: STUDENT_A.id, question: QUESTION, config });
        assert.equal(outcome.status, "error", `${name} ${failure.code}`);
        if (outcome.status === "error") {
          assert.equal(outcome.stage, name === "academic_library_available" ? "availability" : "search");
        }
        assert.equal(oldRpcCalls(), 0, "nunca la RPC antigua");
        if (name === "academic_library_available") assert.equal(gemini.requests.length, 0);
      }

      // Filas con forma inesperada: error, no se pasa basura al prompt.
      reset();
      rowsOverride = [{ texto: "x" }];
      assert.equal((await retrieveAcademicContext({ userId: STUDENT_A.id, question: QUESTION, config })).status, "error");

      // Gemini limita o devuelve otra dimensión: error en el embedding y no se busca.
      for (const mode of ["rate", "dim3072"] as const) {
        reset();
        gemini.mode = mode;
        const outcome = await retrieveAcademicContext({ userId: STUDENT_A.id, question: QUESTION, config });
        assert.deepEqual(outcome, { status: "error", stage: "embedding" }, mode);
        assert.deepEqual(rpcCalls.map((c) => c.name), ["academic_library_available"]);
      }
      assert.equal(oldRpcCalls(), 0);
    }
    assert.equal(stub.calls.filter((c) => c.table === "rpc/match_document_chunks").length, 0, "la RPC antigua no se llamó nunca");
  } finally {
    stub.restore();
  }
}

async function main() {
  prepareRouteTestEnv({ GEMINI_EMBED_MODEL: "gemini-embedding-001", GEMINI_EMBED_DIM: "768" });
  const rag = await import("../chat/academicRag");
  runConfig(rag);
  await runRetrieval(rag);
  console.log("academicRag tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
