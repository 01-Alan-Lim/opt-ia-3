import assert from "node:assert/strict";

import { prepareRouteTestEnv } from "./assistantRouteHarness";
import { installRestStub, type RestRow, type RestStubState } from "./restStubHarness";
import {
  countByStatus,
  DEFAULT_LIBRARY_FILTERS,
  describeChunks,
  filterLibraryDocuments,
  isDefaultLibraryFilters,
  isStalledProcessing,
  needsReindex,
  readLibraryErrorMessage,
  readLibraryResponse,
  STALLED_PROCESSING_MS,
  summarizeLibraryDocuments,
  type LibraryDocument,
  type LibraryDocumentRow,
  type LibraryFilters,
} from "../teacher/library/catalog";

// Biblioteca Académica del panel docente: resumen y filtros (src/lib/teacher/library/catalog.ts)
// y la ruta de solo lectura /api/teacher/library con Supabase simulado (sin red): permisos,
// documentos globales, fragmentos contados por modelo y que no salgan textos, vectores ni rutas.

const CURRENT = "gemini-embedding-001:768";
const NOW = new Date("2026-10-20T15:00:00Z");

type Json = Record<string, unknown>;

function row(overrides: Partial<LibraryDocumentRow> & { id: string }): LibraryDocumentRow {
  return {
    title: "Documento",
    path: `mypes/${overrides.id}.pdf`,
    file_type: "pdf",
    status: "pending",
    is_active: true,
    processing_error: null,
    created_at: "2025-11-29T10:00:00Z",
    updated_at: "2026-10-20T10:00:00Z",
    ...overrides,
  };
}

const ids = (docs: LibraryDocument[]) => docs.map((doc) => doc.id);

function runCatalog() {
  const rows = [
    row({ id: "g1", title: "GUIA_14.1_BALANCEO_DE_LINEA.pdf" }),
    row({ id: "g2", title: "GUIA_12_MUESTREO_DE_TRABAJO.pdf", status: "ready" }),
    row({ id: "demo", title: "Documento demo OPT-IA productividad y ATO", file_type: "txt", is_active: false }),
    row({
      id: "f1",
      title: "Guía de tiempos.docx",
      path: "library/f1.docx",
      file_type: "docx",
      status: "failed",
      processing_error: "NO_TEXT: sin texto extraíble.",
    }),
    row({
      id: "p1",
      title: "Estudio de métodos.pdf",
      path: "library/p1.pdf",
      status: "processing",
      updated_at: new Date(NOW.getTime() - STALLED_PROCESSING_MS - 1000).toISOString(),
    }),
    row({ id: "p2", title: "Lean.pdf", status: "processing", updated_at: NOW.toISOString() }),
    row({ id: "e1", title: "Vacío.pdf", processing_error: "no debería mostrarse" }),
  ];
  const tag = (documentId: string, model: string, n = 1) =>
    Array.from({ length: n }, () => ({ document_id: documentId, embedding_model: model }));
  const tags = [
    ...tag("g1", "legacy-768", 3),
    ...tag("g2", "legacy-768", 9),
    ...tag("g2", CURRENT, 12),
    ...tag("g2", "text-embedding-004:768"),
    ...tag("demo", "legacy-768", 3),
    ...tag("fantasma", CURRENT),
  ];

  {
    // Fragmentos por modelo, orden de la API, motivo del error solo con failed, processing colgado.
    const docs = summarizeLibraryDocuments(rows, tags, { currentModel: CURRENT, now: NOW });
    const byId = Object.fromEntries(docs.map((doc) => [doc.id, doc]));
    assert.deepEqual(ids(docs), rows.map((r) => r.id), "conserva el orden de la API");
    assert.deepEqual(byId.g1.chunks, { total: 3, current: 0, legacy: 3, other: 0 });
    assert.deepEqual(byId.g2.chunks, { total: 22, current: 12, legacy: 9, other: 1 });
    assert.deepEqual(byId.demo.chunks, { total: 3, current: 0, legacy: 3, other: 0 });
    assert.deepEqual(byId.f1.chunks, { total: 0, current: 0, legacy: 0, other: 0 });
    assert.equal(byId.f1.processingError, "NO_TEXT: sin texto extraíble.");
    assert.equal(byId.e1.processingError, null, "el motivo solo se muestra con failed");
    assert.equal(byId.demo.isActive, false);
    assert.equal(byId.p1.stalled, true, "más de 15 minutos en processing");
    assert.equal(byId.p2.stalled, false);
    assert.equal(byId.g1.stalled, false);

    // Se continúa o reintenta solo lo que subió la Biblioteca y quedó sin terminar.
    assert.equal(byId.f1.canProcess, true, "failed en library/");
    assert.equal(byId.p1.canProcess, true, "processing en library/");
    assert.equal(byId.p2.canProcess, false, "processing fuera de library/");
    assert.equal(byId.g1.canProcess, false, "guía antigua pendiente");
    assert.equal(byId.g2.canProcess, false, "lista");
    assert.equal(isStalledProcessing("processing", "no-es-fecha", NOW), false);

    // Lectura del índice para el docente.
    assert.equal(needsReindex(byId.g1), true);
    assert.equal(needsReindex(byId.g2), false);
    assert.equal(needsReindex(byId.f1), false, "sin fragmentos no hay nada que reindexar");
    assert.equal(describeChunks(byId.g1), "3 con el modelo anterior");
    assert.equal(describeChunks(byId.g2), "12 con el modelo actual · 9 con el modelo anterior · 1 con otro modelo");
    assert.equal(describeChunks(byId.f1), "Sin fragmentos");

    assert.deepEqual(countByStatus(docs), { pending: 3, processing: 2, ready: 1, failed: 1 });

    // Búsqueda sin mayúsculas ni tildes, guiones bajos como espacios, y filtros combinados.
    const filter = (filters: Partial<LibraryFilters>) => ids(filterLibraryDocuments(docs, { ...DEFAULT_LIBRARY_FILTERS, ...filters }));
    assert.deepEqual(filter({}), ids(docs));
    assert.deepEqual(filter({ query: "balanceo linea" }), ["g1"]);
    assert.deepEqual(filter({ query: "GUÍA" }), ["g1", "g2", "f1"]);
    assert.deepEqual(filter({ query: "metodos" }), ["p1"]);
    assert.deepEqual(filter({ query: "ato" }), ["demo"]);
    assert.deepEqual(filter({ query: "ato", availability: "active" }), []);
    assert.deepEqual(filter({ status: "processing" }), ["p1", "p2"]);
    assert.deepEqual(filter({ availability: "inactive" }), ["demo"]);
    assert.deepEqual(filter({ availability: "active", status: "pending" }), ["g1", "e1"]);
    assert.equal(isDefaultLibraryFilters(DEFAULT_LIBRARY_FILTERS), true);
    assert.equal(isDefaultLibraryFilters({ ...DEFAULT_LIBRARY_FILTERS, query: "   " }), true);
    assert.equal(isDefaultLibraryFilters({ ...DEFAULT_LIBRARY_FILTERS, status: "ready" }), false);
  }
  {
    // Sin modelo actual (configuración inválida), ningún fragmento cuenta como actual.
    const docs = summarizeLibraryDocuments(rows, tags, { currentModel: null, now: NOW });
    assert.deepEqual(docs.find((doc) => doc.id === "g2")?.chunks, { total: 22, current: 0, legacy: 9, other: 13 });
  }
  {
    // Lectura defensiva de la respuesta y de los mensajes de error.
    assert.equal(readLibraryResponse(null), null);
    assert.equal(readLibraryResponse({ ok: true, data: { documents: [{ id: "x" }], currentEmbeddingModel: null } }), null);
    assert.equal(readLibraryResponse({ ok: false, code: "FORBIDDEN", message: "Solo docentes." }), null);
    assert.deepEqual(readLibraryResponse({ ok: true, data: { documents: [], currentEmbeddingModel: CURRENT } }), {
      documents: [],
      currentEmbeddingModel: CURRENT,
    });
    assert.equal(readLibraryErrorMessage({ ok: false, code: "INTERNAL_ERROR", message: "No se pudo cargar la biblioteca." }), "No se pudo cargar la biblioteca.");
    assert.equal(readLibraryErrorMessage({ message: "  " }), null);
    assert.equal(readLibraryErrorMessage("texto"), null);
  }
}

async function runRoute() {
  const TEACHER = { id: "10000000-0000-4000-8000-000000000001", email: "docente@gmail.com" };
  const STUDENT = { id: "20000000-0000-4000-8000-000000000002", email: "ana@umsa.bo" };
  const GUIDE = "a0000000-0000-4000-8000-000000000001";
  const NEW_DOC = "a0000000-0000-4000-8000-000000000002";
  const OWN_DOC = "a0000000-0000-4000-8000-000000000003";
  const DEMO = "c2a034c3-f840-483b-aafa-a1f45a1cc0e4";

  const doc = (id: string, extra: RestRow): RestRow => ({
    id,
    title: "Documento",
    path: `mypes/${id}.pdf`,
    description: "Descripción interna",
    user_id: null,
    file_type: "pdf",
    status: "pending",
    is_active: true,
    processing_error: null,
    content_hash: null,
    created_at: "2025-12-01T10:00:00Z",
    updated_at: "2026-10-20T10:00:00Z",
    ...extra,
  });
  let chunkId = 0;
  const chunks = (documentId: string, n: number, model: string): RestRow[] =>
    Array.from({ length: n }, (_, index) => ({
      id: ++chunkId,
      document_id: documentId,
      chunk_index: index,
      content: `texto interno ${documentId} ${index}`,
      embedding: "[0.125,0.25,0.5]",
      embedding_model: model,
      created_at: "2025-12-01T10:00:00Z",
    }));

  const state: RestStubState = {
    user: null,
    tables: {
      documents: [
        doc(GUIDE, { title: "GUIA_13_ESTUDIO_DE_TIEMPOS.pdf", path: "mypes/GUIA_13_ESTUDIO_DE_TIEMPOS.pdf" }),
        doc(DEMO, {
          title: "Documento demo OPT-IA productividad y ATO",
          path: "demo/opt-ia-demo.txt",
          file_type: "txt",
          is_active: false,
          created_at: "2025-11-28T10:00:00Z",
        }),
        doc(NEW_DOC, {
          title: "Guía nueva.docx",
          path: "library/nueva.docx",
          file_type: "docx",
          status: "ready",
          content_hash: "a".repeat(64),
          created_at: "2026-10-20T10:00:00Z",
        }),
        doc(OWN_DOC, { title: "Documento de un estudiante.pdf", user_id: STUDENT.id, created_at: "2026-10-19T10:00:00Z" }),
      ],
      document_chunks: [
        ...chunks(GUIDE, 8, "legacy-768"),
        ...chunks(DEMO, 3, "legacy-768"),
        ...chunks(NEW_DOC, 5, CURRENT),
        ...chunks(OWN_DOC, 2, CURRENT),
      ],
    },
  };

  prepareRouteTestEnv({
    ALLOWED_EMAIL_DOMAIN: "umsa.bo",
    TEACHER_EMAIL_ALLOWLIST: TEACHER.email,
    GEMINI_EMBED_MODEL: "gemini-embedding-001",
    GEMINI_EMBED_DIM: "768",
  });
  const route = await import("../../app/api/teacher/library/route");
  const stub = installRestStub(state);

  async function call(user: { id: string; email: string } | null) {
    state.user = user;
    const res = await route.GET(
      new Request("https://opt-ia.test/api/teacher/library", { headers: { authorization: "Bearer token-de-prueba" } })
    );
    return { status: res.status, json: (await res.json()) as Json };
  }
  const libraryReads = () => stub.calls.filter((c) => c.table === "documents" || c.table === "document_chunks").length;

  try {
    {
      // Sin sesión o sin rol docente: no se lee la biblioteca.
      const anonymous = await call(null);
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.json.code, "UNAUTHORIZED");
      const student = await call(STUDENT);
      assert.equal(student.status, 403);
      assert.deepEqual(student.json, { ok: false, code: "FORBIDDEN", message: "Solo docentes." });
      assert.equal(libraryReads(), 0, "sin rol docente no se consulta la base");
    }
    {
      // Docente: solo documentos globales, del más reciente al más antiguo, con fragmentos por modelo.
      const teacher = await call(TEACHER);
      assert.equal(teacher.status, 200);
      const data = readLibraryResponse(teacher.json);
      assert.ok(data, "la respuesta tiene la forma que lee el panel");
      assert.equal(data.currentEmbeddingModel, CURRENT);
      assert.deepEqual(ids(data.documents), [NEW_DOC, GUIDE, DEMO], "sin el documento del estudiante");

      const byId = Object.fromEntries(data.documents.map((d) => [d.id, d]));
      assert.deepEqual(byId[GUIDE].chunks, { total: 8, current: 0, legacy: 8, other: 0 });
      assert.deepEqual(byId[NEW_DOC].chunks, { total: 5, current: 5, legacy: 0, other: 0 });
      assert.deepEqual(byId[DEMO].chunks, { total: 3, current: 0, legacy: 3, other: 0 });
      assert.equal(byId[DEMO].isActive, false);
      assert.equal(byId[DEMO].fileType, "txt");
      assert.equal(byId[NEW_DOC].status, "ready");

      // Solo los campos de la vista: ni rutas, ni texto, ni vectores, ni dueño, ni hash.
      const documents = (teacher.json.data as Json).documents as Json[];
      for (const item of documents) {
        assert.deepEqual(Object.keys(item).sort(), [
          "canProcess", "chunks", "createdAt", "fileType", "id", "isActive", "processingError", "stalled", "status", "title", "updatedAt",
        ]);
      }
      const body = JSON.stringify(teacher.json);
      for (const secret of ["mypes/", "demo/opt-ia-demo.txt", "texto interno", "[0.125", "Descripción interna", STUDENT.id, "aaaaaaaa"]) {
        assert.ok(!body.includes(secret), `no sale: ${secret}`);
      }

      // Los fragmentos se piden solo de los documentos listados.
      const chunkCalls = stub.calls.filter((c) => c.table === "document_chunks").map((c) => decodeURIComponent(c.url));
      assert.equal(chunkCalls.length, 1);
      assert.ok(chunkCalls[0].includes(GUIDE) && chunkCalls[0].includes(DEMO) && chunkCalls[0].includes(NEW_DOC));
      assert.ok(!chunkCalls[0].includes(OWN_DOC), "nunca los de un estudiante");

      assert.equal(stub.writes("documents") + stub.writes("document_chunks"), 0, "solo lectura");
    }
    {
      // Configuración de embeddings inválida: la lista sale igual, sin fragmentos actuales.
      process.env.GEMINI_EMBED_DIM = "1536";
      const data = readLibraryResponse((await call(TEACHER)).json);
      process.env.GEMINI_EMBED_DIM = "768";
      assert.equal(data?.currentEmbeddingModel, null);
      assert.deepEqual(data?.documents.find((d) => d.id === NEW_DOC)?.chunks, { total: 5, current: 0, legacy: 0, other: 5 });
    }
    {
      // Base sin M4 (columna inexistente): 503 sin detalles de Supabase.
      state.failTables = { documents: { status: 400, code: "42703", message: "column documents.status does not exist" } };
      const missing = await call(TEACHER);
      assert.equal(missing.status, 503);
      assert.equal(missing.json.code, "SCHEMA_NOT_READY");
      assert.ok(!JSON.stringify(missing.json).includes("column"), "sin el mensaje de la base");

      // Otro error de lectura o una fila con forma inesperada: 500 genérico.
      state.failTables = { document_chunks: { status: 500, code: "XX000", message: "boom" } };
      const failed = await call(TEACHER);
      assert.equal(failed.status, 500);
      assert.equal(failed.json.code, "INTERNAL_ERROR");
      assert.ok(!JSON.stringify(failed.json).includes("boom"));
      state.failTables = {};

      const guide = state.tables.documents.find((d) => d.id === GUIDE);
      if (guide) guide.status = "archived";
      const malformed = await call(TEACHER);
      if (guide) guide.status = "pending";
      assert.equal(malformed.status, 500);
      assert.equal(malformed.json.code, "INTERNAL_ERROR");
    }
  } finally {
    stub.restore();
  }
}

async function main() {
  runCatalog();
  await runRoute();
  console.log("academicLibrary tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
