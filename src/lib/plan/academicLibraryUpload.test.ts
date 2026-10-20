import assert from "node:assert/strict";

import { prepareRouteTestEnv } from "./assistantRouteHarness";
import { installRestStub, nextTimestamp, type RestRow, type RestStubState } from "./restStubHarness";
import { MAX_EMBED_INPUT_CHARS, vectorNorm } from "../embeddingEngine";
import {
  MAX_UPLOAD_BYTES,
  readLibraryResponse,
  readProcessResponse,
  readUploadResponse,
  uploadCandidateProblem,
  type LibraryProcessResponse,
} from "../teacher/library/catalog";
import {
  checkDocxStructure,
  checkSignature,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkText,
  LibraryFileError,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  normalizeExtractedText,
  prepareLibraryText,
  readZipDirectory,
  sha256Hex,
  titleFromFileName,
} from "../teacher/library/ingest";

// Carga de documentos de la Biblioteca Académica: reglas del archivo (ingest.ts), extracción real
// (pdf-parse y mammoth) y las rutas POST /api/teacher/library y /api/teacher/library/:id/process
// con Supabase, Storage y Gemini simulados (sin red). Los PDF y DOCX se arman aquí, en memoria.

const CURRENT = "gemini-embedding-001:768";
type Json = Record<string, unknown>;

// ---------------- Archivos de prueba ----------------

function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

// PDF digital de una página con texto (Helvetica, WinAnsi para las tildes).
function buildPdf(lines: string[]): Uint8Array {
  const escape = (s: string) => s.replace(/[\\()]/g, (m) => `\\${m}`);
  const content = `BT /F1 11 Tf 40 780 Td 14 TL ${lines.map((line) => `(${escape(line)}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(pdf);
}

function guideLines(label: string): string[] {
  return [
    `${label}: el balanceo de línea distribuye las tareas entre estaciones de trabajo.`,
    "El objetivo es reducir el tiempo de ciclo y el tiempo ocioso de cada estación.",
    "Se calcula la eficiencia como el tiempo total de tareas sobre el producto de estaciones y ciclo.",
    "El método heurístico asigna primero las tareas con mayor tiempo y menos predecesoras.",
  ];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Zip sin compresión. declaredSize permite mentir el tamaño descomprimido (zip inflado).
function zip(files: Array<{ name: string; content: string; declaredSize?: number }>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, file.declaredSize ?? data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local);
    central.push(entry);
    offset += local.length;
  }
  const directorySize = central.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildDocx(paragraphs: string[], options: { declaredDocumentSize?: number; withoutDocument?: boolean } = {}): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`).join("");
  const files = [
    {
      name: "[Content_Types].xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
  ];
  if (!options.withoutDocument) {
    files.push({
      name: "word/document.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ...(options.declaredDocumentSize ? { declaredSize: options.declaredDocumentSize } : {}),
    } as { name: string; content: string; declaredSize?: number });
  }
  return zip(files);
}

function longParagraphs(label: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${label} ${i}: el estudio de tiempos mide la duración de cada operación del proceso para fijar un estándar de trabajo.`
  );
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err: unknown) {
    return err instanceof LibraryFileError ? err.code : "OTHER";
  }
}

// ---------------- Reglas del archivo (puras) ----------------

function runIngestRules() {
  assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  // Firma según la extensión.
  const pdf = buildPdf(guideLines("Firma"));
  const docx = buildDocx(["Hola"]);
  assert.equal(codeOf(() => checkSignature(pdf, "pdf")), null);
  assert.equal(codeOf(() => checkSignature(docx, "docx")), null);
  assert.equal(codeOf(() => checkSignature(docx, "pdf")), "INVALID_FILE", "un DOCX con extensión .pdf");
  assert.equal(codeOf(() => checkSignature(pdf, "docx")), "INVALID_FILE", "un PDF con extensión .docx");
  assert.equal(codeOf(() => checkSignature(new Uint8Array(0), "pdf")), "INVALID_FILE", "vacío");

  // Estructura del DOCX: zip válido, con el documento, y sin inflarse más de la cuenta.
  assert.deepEqual(readZipDirectory(docx)?.map((entry) => entry.name), ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  assert.equal(codeOf(() => checkDocxStructure(docx)), null);
  assert.equal(readZipDirectory(docx.subarray(0, docx.length - 30)), null, "truncado");
  assert.equal(codeOf(() => checkDocxStructure(docx.subarray(0, docx.length - 30))), "INVALID_FILE");
  assert.equal(codeOf(() => checkDocxStructure(buildDocx([], { withoutDocument: true }))), "INVALID_FILE");
  assert.equal(
    codeOf(() => checkDocxStructure(buildDocx(["x"], { declaredDocumentSize: MAX_DOCX_UNCOMPRESSED_BYTES + 1 }))),
    "DOCUMENT_TOO_LONG"
  );

  // Limpieza del texto extraído.
  assert.equal(
    normalizeExtractedText("Línea\r\nuno\t\tcon  espacios\u0000\n\n\n\nproduc-\nción y semi­automático\n  fin  "),
    "Línea\nuno con espacios\n\nproducción y semiautomático\nfin"
  );
  assert.equal(normalizeExtractedText("Pre-\nIndustrial"), "Pre-\nIndustrial", "no une si sigue una mayúscula");

  // Fragmentos: tamaño acotado, cortes naturales, solapamiento, cobertura y determinismo.
  const text = normalizeExtractedText(longParagraphs("Párrafo", 120).join("\n\n"));
  const chunks = chunkText(text);
  assert.ok(chunks.length > 5, String(chunks.length));
  assert.ok(chunks.every((chunk) => chunk.length <= CHUNK_TARGET_CHARS && chunk.length <= MAX_EMBED_INPUT_CHARS));
  assert.ok(chunks.slice(0, -1).every((chunk) => /[.!?]$/.test(chunk)), "cada corte cae al final de una oración o párrafo");
  for (let i = 1; i < chunks.length; i++) {
    const tail = chunks[i - 1].slice(-CHUNK_OVERLAP_CHARS + 40);
    assert.ok(chunks[i].includes(tail.slice(-60)), `solapamiento entre ${i - 1} y ${i}`);
  }
  for (const marker of ["Párrafo 0:", "Párrafo 57:", "Párrafo 119:"]) {
    assert.ok(chunks.some((chunk) => chunk.includes(marker)), `cubre ${marker}`);
  }
  assert.deepEqual(chunkText(text), chunks, "determinista");
  // Una sola "palabra" enorme igual avanza, en cortes de tamaño máximo.
  const solid = chunkText("x".repeat(4000));
  assert.ok(solid.length >= 3 && solid.every((chunk) => chunk.length <= CHUNK_TARGET_CHARS));

  // Límites del texto.
  assert.equal(codeOf(() => prepareLibraryText("Hola, poco texto.")), "NO_EXTRACTABLE_TEXT");
  assert.equal(codeOf(() => prepareLibraryText(`${"   \n".repeat(500)}1 2 3`)), "NO_EXTRACTABLE_TEXT");
  assert.equal(codeOf(() => prepareLibraryText(longParagraphs("Largo", 4000).join("\n\n"))), "DOCUMENT_TOO_LONG");
  assert.ok(prepareLibraryText(guideLines("Límite").join("\n")).chunks.length === 1);

  assert.equal(titleFromFileName("GUIA_16_ESTUDIO_DE_METODOS.pdf"), "GUIA_16_ESTUDIO_DE_METODOS");
  assert.equal(titleFromFileName(".pdf"), "Documento");

  // Aviso previo del navegador.
  assert.equal(uploadCandidateProblem({ name: "guia.pdf", size: 1000 }), null);
  assert.equal(uploadCandidateProblem({ name: "guia.DOCX", size: 1000 }), null);
  assert.ok(uploadCandidateProblem({ name: "guia.doc", size: 1000 }));
  assert.ok(uploadCandidateProblem({ name: "guia.pdf", size: 0 }));
  assert.ok(uploadCandidateProblem({ name: "guia.pdf", size: MAX_UPLOAD_BYTES + 1 }));
}

// ---------------- Supabase, Storage y Gemini simulados ----------------

const TEACHER = { id: "10000000-0000-4000-8000-000000000001", email: "docente@gmail.com" };
const STUDENT = { id: "20000000-0000-4000-8000-000000000002", email: "ana@umsa.bo" };
const GUIDE = "a0000000-0000-4000-8000-000000000001";
const STUDENT_DOC = "a0000000-0000-4000-8000-000000000003";

let chunkSeq = 0;
const state: RestStubState = {
  user: null,
  tables: {
    documents: [
      {
        id: GUIDE,
        title: "GUIA_13_ESTUDIO_DE_TIEMPOS.pdf",
        path: "mypes/GUIA_13_ESTUDIO_DE_TIEMPOS.pdf",
        description: null,
        user_id: null,
        file_type: "pdf",
        status: "pending",
        is_active: true,
        processing_error: null,
        content_hash: null,
        created_at: "2025-12-01T10:00:00Z",
        updated_at: "2026-10-20T10:00:00Z",
      },
      {
        id: STUDENT_DOC,
        title: "Documento propio.pdf",
        path: "x/propio.pdf",
        description: null,
        user_id: STUDENT.id,
        file_type: "pdf",
        status: "processing",
        is_active: false,
        processing_error: null,
        content_hash: null,
        created_at: "2026-10-01T10:00:00Z",
        updated_at: "2026-10-01T10:00:00Z",
      },
    ],
    document_chunks: Array.from({ length: 8 }, (_, index) => ({
      id: ++chunkSeq,
      document_id: GUIDE,
      chunk_index: index,
      content: `guía antigua ${index}`,
      embedding: [0.1, 0.2],
      embedding_model: "legacy-768",
      created_at: "2025-12-01T10:00:00Z",
    })),
  },
  uniques: {
    documents: [
      { name: "documents_content_hash_key", columns: ["content_hash"], where: (r) => r.content_hash !== null && r.content_hash !== undefined },
    ],
    document_chunks: [
      { name: "document_chunks_document_model_chunk_key", columns: ["document_id", "embedding_model", "chunk_index"] },
    ],
  },
  defaults: {
    documents: () => ({ created_at: nextTimestamp(), updated_at: nextTimestamp(), description: null, processing_error: null }),
    document_chunks: () => ({ id: ++chunkSeq, created_at: nextTimestamp() }),
  },
  storage: {},
};

type GeminiMode = "ok" | "dim3072" | "rate" | "reject";
const gemini = { mode: "ok" as GeminiMode, requests: [] as Json[], embedded: [] as string[] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const textOf = (request: Json) =>
  ((request.content as { parts?: Array<{ text?: string }> } | undefined)?.parts ?? []).map((part) => part.text ?? "").join("");

// Vector sin normalizar y distinto por texto: el motor lo normaliza.
function fakeVector(text: string, dimension: number): number[] {
  let seed = 0;
  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) % 9973;
  return Array.from({ length: dimension }, (_, k) => ((seed + k * 7) % 13) - 6 + 0.25);
}

async function geminiEndpoint(req: Request, url: URL): Promise<Response | null> {
  if (url.host !== "generativelanguage.googleapis.com") return null;
  const body = (await req.json()) as Json & { requests?: Json[] };
  const requests = body.requests ?? [body];
  gemini.requests.push(...requests);
  if (gemini.mode === "rate") {
    return jsonResponse({ error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" } }, 429);
  }
  if (gemini.mode === "reject") {
    return jsonResponse({ error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" } }, 400);
  }
  const dimension = gemini.mode === "dim3072" ? 3072 : 768;
  const embeddings = requests.map((request) => {
    gemini.embedded.push(textOf(request));
    return { values: fakeVector(textOf(request), dimension) };
  });
  return jsonResponse(url.pathname.endsWith(":batchEmbedContents") ? { embeddings } : { embedding: embeddings[0] });
}

const docs = () => state.tables.documents;
const docRow = (id: string) => docs().find((d) => d.id === id) as RestRow;
const currentChunks = (id: string) =>
  state.tables.document_chunks.filter((c) => c.document_id === id && c.embedding_model === CURRENT);
const storedObjects = () => Object.keys(state.storage ?? {});

async function runRoutes() {
  prepareRouteTestEnv({
    ALLOWED_EMAIL_DOMAIN: "umsa.bo",
    TEACHER_EMAIL_ALLOWLIST: TEACHER.email,
    GEMINI_EMBED_MODEL: "gemini-embedding-001",
    GEMINI_EMBED_DIM: "768",
  });
  const libraryRoute = await import("../../app/api/teacher/library/route");
  const processRoute = await import("../../app/api/teacher/library/[id]/process/route");
  const { extractLibraryText, PROCESS_BATCH } = await import("../teacher/library/processing");
  const stub = installRestStub(state, geminiEndpoint);

  const headers = () => new Headers({ authorization: "Bearer token-de-prueba" });

  async function upload(
    user: { id: string; email: string } | null,
    file: { name: string; bytes: Uint8Array } | null,
    options: { title?: string } = {}
  ) {
    state.user = user;
    const form = new FormData();
    if (file) form.append("file", new File([Uint8Array.from(file.bytes)], file.name));
    if (options.title !== undefined) form.append("title", options.title);
    const res = await libraryRoute.POST(new Request("https://opt-ia.test/api/teacher/library", { method: "POST", headers: headers(), body: form }));
    return { status: res.status, json: (await res.json()) as Json };
  }

  async function step(user: { id: string; email: string } | null, id: string) {
    state.user = user;
    const res = await processRoute.POST(
      new Request(`https://opt-ia.test/api/teacher/library/${id}/process`, { method: "POST", headers: headers() }),
      { params: Promise.resolve({ id }) }
    );
    return { status: res.status, json: (await res.json()) as Json };
  }

  async function processAll(id: string): Promise<LibraryProcessResponse[]> {
    const steps: LibraryProcessResponse[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await step(TEACHER, id);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const data = readProcessResponse(res.json);
      assert.ok(data, "respuesta de paso con la forma que lee el panel");
      steps.push(data);
      if (data.done || data.document.status === "failed" || data.retryAfterMs) break;
    }
    return steps;
  }

  async function uploaded(name: string, bytes: Uint8Array, title?: string) {
    const res = await upload(TEACHER, { name, bytes }, { title });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const data = readUploadResponse(res.json);
    assert.ok(data);
    return data;
  }

  try {
    {
      // Extracción real, sin OCR: PDF (con un Buffer de Node, que pdf-parse no lee sin la copia) y DOCX.
      const pdfText = await extractLibraryText("pdf", Buffer.from(buildPdf(guideLines("Extracción"))));
      assert.ok(pdfText.includes("balanceo de línea") && pdfText.includes("heurístico"), pdfText);
      const docxText = await extractLibraryText("docx", buildDocx(["Primer párrafo del documento.", "Segundo párrafo."]));
      assert.ok(docxText.includes("Primer párrafo del documento.") && docxText.includes("Segundo párrafo."), docxText);
      await assert.rejects(extractLibraryText("pdf", latin1("%PDF-1.4 esto no es un PDF")), (err: unknown) => err instanceof LibraryFileError && err.code === "INVALID_FILE");
    }

    const pdfBytes = buildPdf(guideLines("Guía 16"));
    {
      // Sin sesión o sin rol docente: ni se guarda nada ni se llama a Gemini.
      assert.equal((await upload(null, { name: "guia.pdf", bytes: pdfBytes })).status, 401);
      const student = await upload(STUDENT, { name: "guia.pdf", bytes: pdfBytes });
      assert.equal(student.status, 403);
      assert.equal(student.json.code, "FORBIDDEN");
      assert.equal((await step(null, GUIDE)).status, 401);
      assert.equal((await step(STUDENT, GUIDE)).status, 403);
      assert.equal(docs().length, 2);
      assert.deepEqual(storedObjects(), []);
      assert.equal(gemini.requests.length, 0);
      assert.equal(stub.writes("documents") + stub.writes("document_chunks"), 0);
    }

    // ---------------- PDF válido: subida y procesamiento ----------------
    const pdf = await uploaded("GUIA_16_BALANCEO.pdf", pdfBytes, "Guía 16 · Balanceo de línea");
    {
      assert.equal(pdf.document.status, "processing");
      assert.equal(pdf.document.isActive, false, "nace inactivo");
      assert.equal(pdf.document.fileType, "pdf");
      assert.equal(pdf.document.canProcess, true);
      assert.equal(pdf.document.title, "Guía 16 · Balanceo de línea");
      assert.equal(pdf.totalChunks, 1);
      const row = docRow(pdf.document.id);
      assert.equal(row.user_id, null, "documento global");
      assert.equal(row.content_hash, sha256Hex(pdfBytes));
      assert.equal(row.path, `library/${pdf.document.id}.pdf`);
      const object = state.storage?.[`documents/library/${pdf.document.id}.pdf`];
      assert.ok(object, "guardado en Storage");
      assert.deepEqual(new Uint8Array(object.bytes), pdfBytes, "el archivo tal cual");
      assert.equal(gemini.requests.length, 0, "la subida no genera embeddings");

      const steps = await processAll(pdf.document.id);
      const last = steps[steps.length - 1];
      assert.equal(last.done, true);
      assert.equal(last.document.status, "ready");
      assert.equal(last.document.isActive, false, "listo pero inactivo hasta la revisión");
      assert.equal(last.document.canProcess, false);
      assert.deepEqual(last.document.chunks, { total: 1, current: 1, legacy: 0, other: 0 });
      const stored = currentChunks(pdf.document.id);
      assert.equal(stored.length, 1);
      assert.ok((stored[0].content as string).includes("balanceo de línea"));
      const embedding = stored[0].embedding as number[];
      assert.equal(embedding.length, 768);
      assert.ok(Math.abs(vectorNorm(embedding) - 1) < 1e-9, "normalizado");
      assert.ok(gemini.requests.every((r) => r.taskType === "RETRIEVAL_DOCUMENT" && r.outputDimensionality === 768 && r.model === "models/gemini-embedding-001"));

      // Procesar otra vez un documento listo no vuelve a llamar a Gemini.
      const calls = gemini.requests.length;
      const again = readProcessResponse((await step(TEACHER, pdf.document.id)).json);
      assert.equal(again?.done, true);
      assert.equal(gemini.requests.length, calls);
    }

    // ---------------- DOCX válido en varios pasos ----------------
    const docxBytes = buildDocx(longParagraphs("Métodos", 700));
    {
      const docx = await uploaded("Estudio de métodos.docx", docxBytes);
      assert.equal(docx.document.title, "Estudio de métodos");
      assert.equal(docx.document.fileType, "docx");
      assert.ok(docx.totalChunks > PROCESS_BATCH, `${docx.totalChunks} fragmentos`);
      const steps = await processAll(docx.document.id);
      assert.equal(steps.length, Math.ceil(docx.totalChunks / PROCESS_BATCH));
      const progress = steps.map((s) => s.processedChunks);
      assert.ok(progress.every((value, i) => i === 0 || value > progress[i - 1]), `progreso ${progress}`);
      assert.equal(steps[steps.length - 1].document.status, "ready");
      const stored = currentChunks(docx.document.id);
      assert.equal(stored.length, docx.totalChunks);
      assert.deepEqual(
        stored.map((c) => c.chunk_index as number).sort((a, b) => a - b),
        Array.from({ length: docx.totalChunks }, (_, i) => i),
        "todos los índices, sin repetidos"
      );
      assert.ok(stored.every((c) => (c.content as string).length <= MAX_EMBED_INPUT_CHARS));
    }

    // ---------------- Duplicados ----------------
    {
      const before = { docs: docs().length, objects: storedObjects().length };
      const duplicate = await upload(TEACHER, { name: "otro-nombre.pdf", bytes: pdfBytes });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.json.code, "CONFLICT");
      assert.ok(String(duplicate.json.message).includes("Guía 16 · Balanceo de línea"), String(duplicate.json.message));
      assert.deepEqual({ docs: docs().length, objects: storedObjects().length }, before, "nada nuevo guardado");

      // Mismo hash en un documento de estudiante: lo frena el índice único; se borra lo subido y
      // no se revela el título ajeno.
      const clash = buildPdf(guideLines("Colisión"));
      (docRow(STUDENT_DOC) as RestRow).content_hash = sha256Hex(clash);
      const conflict = await upload(TEACHER, { name: "colision.pdf", bytes: clash });
      assert.equal(conflict.status, 409);
      assert.ok(!String(conflict.json.message).includes("Documento propio"));
      assert.deepEqual({ docs: docs().length, objects: storedObjects().length }, before, "lo subido a Storage se borró");
    }

    // ---------------- Archivos inválidos: 4xx y nada guardado ----------------
    {
      const before = { docs: docs().length, objects: storedObjects().length, gemini: gemini.requests.length };
      const cases: Array<[string, Uint8Array | null, number, string, string?]> = [
        ["vacio.pdf", new Uint8Array(0), 400, "INVALID_FILE"],
        ["notas.txt", latin1("texto plano ".repeat(50)), 400, "INVALID_FILE"],
        ["roto.pdf", latin1("%PDF-1.4 esto no es un PDF"), 400, "INVALID_FILE"],
        ["word-renombrado.pdf", buildDocx(["Hola"]), 400, "INVALID_FILE"],
        ["pdf-renombrado.docx", buildPdf(guideLines("Renombrado")), 400, "INVALID_FILE"],
        ["sin-documento.docx", buildDocx([], { withoutDocument: true }), 400, "INVALID_FILE"],
        ["truncado.docx", docxBytes.subarray(0, docxBytes.length - 40), 400, "INVALID_FILE"],
        ["inflado.docx", buildDocx(["x"], { declaredDocumentSize: MAX_DOCX_UNCOMPRESSED_BYTES + 1 }), 400, "DOCUMENT_TOO_LONG"],
        ["escaneado.pdf", buildPdf(["Hola"]), 400, "NO_EXTRACTABLE_TEXT"],
        ["enorme.docx", buildDocx(longParagraphs("Enorme", 4000)), 400, "DOCUMENT_TOO_LONG"],
        ["grande.pdf", (() => { const big = new Uint8Array(MAX_UPLOAD_BYTES + 1); big.set(latin1("%PDF-1.4\n")); return big; })(), 413, "PAYLOAD_TOO_LARGE"],
        ["(sin archivo)", null, 400, "BAD_REQUEST"],
      ];
      for (const [name, bytes, status, code] of cases) {
        const res = await upload(TEACHER, bytes ? { name, bytes } : null);
        assert.equal(res.status, status, `${name}: ${JSON.stringify(res.json)}`);
        assert.equal(res.json.code, code, name);
        assert.equal(res.json.ok, false);
      }
      const longTitle = await upload(TEACHER, { name: "titulo.pdf", bytes: buildPdf(guideLines("Título")) }, { title: "x".repeat(201) });
      assert.equal(longTitle.status, 400);
      assert.deepEqual(
        { docs: docs().length, objects: storedObjects().length, gemini: gemini.requests.length },
        before,
        "ningún archivo inválido dejó filas, objetos ni llamadas a Gemini"
      );
    }

    // ---------------- Fallos de Supabase y Storage en la subida ----------------
    {
      const before = { docs: docs().length, objects: storedObjects().length };
      state.failStorage = { upload: { status: 500, message: "storage caído" } };
      const storageDown = await upload(TEACHER, { name: "s.pdf", bytes: buildPdf(guideLines("Storage")) });
      state.failStorage = {};
      assert.equal(storageDown.status, 500);
      assert.equal(storageDown.json.code, "INTERNAL_ERROR");
      assert.ok(!JSON.stringify(storageDown.json).includes("storage caído"));

      state.failTables = { documents: { status: 500, code: "XX000", message: "insert caído", methods: ["POST"] } };
      const insertDown = await upload(TEACHER, { name: "i.pdf", bytes: buildPdf(guideLines("Insert")) });
      state.failTables = {};
      assert.equal(insertDown.status, 500);
      assert.deepEqual({ docs: docs().length, objects: storedObjects().length }, before, "sin fila y sin archivo huérfano");
    }

    // ---------------- Gemini devuelve otra dimensión: falla y se recupera ----------------
    {
      const doc = await uploaded("dimension.pdf", buildPdf(guideLines("Dimensión")));
      gemini.mode = "dim3072";
      const [failed] = await processAll(doc.document.id);
      gemini.mode = "ok";
      assert.equal(failed.document.status, "failed");
      assert.ok(failed.document.processingError?.startsWith("EMBEDDING_DIMENSION"), failed.document.processingError ?? "");
      assert.equal(failed.document.canProcess, true);
      assert.equal(currentChunks(doc.document.id).length, 0, "no se guarda ni se recorta");

      const retried = await processAll(doc.document.id);
      assert.equal(retried[retried.length - 1].document.status, "ready");
      assert.equal(retried[retried.length - 1].document.processingError, null);
    }

    // ---------------- Gemini limita (429): sigue en processing y se continúa ----------------
    {
      const doc = await uploaded("limite.pdf", buildPdf(guideLines("Límite de Gemini")));
      gemini.mode = "rate";
      const [waiting] = await processAll(doc.document.id);
      gemini.mode = "ok";
      assert.equal(waiting.retryAfterMs, 20_000);
      assert.equal(waiting.done, false);
      assert.equal(waiting.document.status, "processing", "no se marca como fallido");
      assert.equal(currentChunks(doc.document.id).length, 0);
      const resumed = await processAll(doc.document.id);
      assert.equal(resumed[resumed.length - 1].document.status, "ready");
    }

    // ---------------- Gemini rechaza la solicitud (400): failed ----------------
    {
      const doc = await uploaded("rechazo.pdf", buildPdf(guideLines("Rechazo")));
      gemini.mode = "reject";
      const [rejected] = await processAll(doc.document.id);
      gemini.mode = "ok";
      assert.equal(rejected.document.status, "failed");
      assert.ok(rejected.document.processingError?.startsWith("EMBEDDING_FAILED"));
    }

    // ---------------- Persistencia parcial y recuperación ----------------
    {
      const doc = await uploaded("parcial.docx", buildDocx(longParagraphs("Parcial", 700)));
      const first = readProcessResponse((await step(TEACHER, doc.document.id)).json);
      assert.equal(first?.processedChunks, PROCESS_BATCH);
      assert.equal(first?.done, false);

      state.failTables = { document_chunks: { status: 500, code: "XX000", message: "insert caído", methods: ["POST"] } };
      const broken = readProcessResponse((await step(TEACHER, doc.document.id)).json);
      state.failTables = {};
      assert.equal(broken?.document.status, "failed");
      assert.ok(broken?.document.processingError?.startsWith("SAVE"));
      assert.equal(currentChunks(doc.document.id).length, PROCESS_BATCH, "lo guardado se conserva");

      // En la lista: fallido, con fragmentos incompletos, nunca "listo".
      state.user = TEACHER;
      const list = readLibraryResponse(
        await (await libraryRoute.GET(new Request("https://opt-ia.test/api/teacher/library", { headers: headers() }))).json()
      );
      const listed = list?.documents.find((d) => d.id === doc.document.id);
      assert.equal(listed?.status, "failed");
      assert.equal(listed?.chunks.current, PROCESS_BATCH);
      assert.equal(listed?.canProcess, true);

      // Reintento: retoma desde lo guardado, sin volver a pedir esos embeddings ni duplicarlos.
      const embeddedBefore = gemini.embedded.length;
      const retried = await processAll(doc.document.id);
      assert.equal(retried[retried.length - 1].document.status, "ready");
      assert.equal(gemini.embedded.length - embeddedBefore, doc.totalChunks - PROCESS_BATCH);
      assert.equal(currentChunks(doc.document.id).length, doc.totalChunks);
    }

    // ---------------- Dos pasos a la vez: sin duplicados ----------------
    {
      const doc = await uploaded("concurrente.docx", buildDocx(longParagraphs("Concurrente", 700)));
      const [a, b] = await Promise.all([step(TEACHER, doc.document.id), step(TEACHER, doc.document.id)]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(currentChunks(doc.document.id).length, PROCESS_BATCH, "el índice único evita duplicar");
      assert.notEqual(docRow(doc.document.id).status, "failed");
      const finished = await processAll(doc.document.id);
      assert.equal(finished[finished.length - 1].document.status, "ready");
      assert.equal(currentChunks(doc.document.id).length, doc.totalChunks);
    }

    // ---------------- El archivo de Storage falta o cambió ----------------
    {
      const missing = await uploaded("falta.pdf", buildPdf(guideLines("Falta")));
      delete state.storage?.[`documents/library/${missing.document.id}.pdf`];
      const [gone] = await processAll(missing.document.id);
      assert.equal(gone.document.status, "failed");
      assert.ok(gone.document.processingError?.startsWith("STORAGE"));

      const changed = await uploaded("cambia.pdf", buildPdf(guideLines("Cambia")));
      const key = `documents/library/${changed.document.id}.pdf`;
      const other = buildPdf(guideLines("Otro contenido"));
      if (state.storage) state.storage[key] = { bytes: Uint8Array.from(other).buffer, contentType: "application/pdf" };
      const [mismatch] = await processAll(changed.document.id);
      assert.equal(mismatch.document.status, "failed");
      assert.ok(mismatch.document.processingError?.startsWith("FILE_MISMATCH"));
    }

    // ---------------- Qué no se procesa desde aquí ----------------
    {
      assert.equal((await step(TEACHER, GUIDE)).status, 409, "guía antigua: la reindexación no está habilitada");
      assert.equal((await step(TEACHER, "b0000000-0000-4000-8000-000000000009")).status, 404);
      assert.equal((await step(TEACHER, STUDENT_DOC)).status, 404, "un documento de estudiante no existe para la biblioteca");
      assert.equal((await step(TEACHER, "no-es-uuid")).status, 400);
    }

    // ---------------- Invariantes finales ----------------
    {
      // Ningún documento "listo" tiene fragmentos incompletos, y ninguno se activó solo.
      const library = docs().filter((d) => String(d.path).startsWith("library/"));
      assert.ok(library.length >= 8);
      for (const doc of library) {
        assert.equal(doc.is_active, false, `${doc.title} sigue inactivo`);
        if (doc.status === "ready") {
          const indices = new Set(currentChunks(String(doc.id)).map((c) => c.chunk_index));
          assert.ok(indices.size > 0 && [...indices].every((i) => typeof i === "number"), String(doc.title));
        }
      }
      // La guía antigua y sus fragmentos legacy no se tocaron.
      assert.equal(docRow(GUIDE).status, "pending");
      assert.equal(state.tables.document_chunks.filter((c) => c.document_id === GUIDE && c.embedding_model === "legacy-768").length, 8);
      assert.equal(state.tables.document_chunks.filter((c) => c.document_id === GUIDE).length, 8);
    }
  } finally {
    stub.restore();
  }
}

async function main() {
  runIngestRules();
  await runRoutes();
  console.log("academicLibraryUpload tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
