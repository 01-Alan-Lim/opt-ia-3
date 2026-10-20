import assert from "node:assert/strict";

import {
  GoogleGenerativeAI,
  TaskType,
  type BatchEmbedContentsRequest,
  type EmbedContentRequest,
} from "@google/generative-ai";

import {
  createEmbeddingEngine,
  DEFAULT_EMBEDDING_CONFIG,
  EmbeddingError,
  embeddingModelId,
  GEMINI_EMBEDDING_NATIVE_DIM,
  isRetryableEmbeddingError,
  isStoredEmbedding,
  MAX_EMBED_INPUT_CHARS,
  readEmbeddingConfig,
  STORED_EMBEDDING_DIM,
  toStoredEmbedding,
  vectorNorm,
  type EmbeddingModelPort,
} from "../embeddingEngine";

// Motor de embeddings de la Biblioteca Académica (embeddingEngine.ts) con Gemini simulado: sin red
// ni API key real. Al final, el SDK real con fetch interceptado comprueba que outputDimensionality y
// taskType salen en la petición, aunque los tipos del SDK no declaren el primero.

const DIM = STORED_EMBEDDING_DIM;

function vector(length: number, at: (index: number) => number = (index) => (index % 7) - 3): number[] {
  return Array.from({ length }, (_, index) => at(index));
}

function unitOf(values: number[]): number[] {
  const norm = vectorNorm(values);
  return values.map((value) => value / norm);
}

// Vector de 768 sin normalizar que lleva el número final del texto en la primera componente: después
// de normalizar, v[0] / v[1] lo recupera (sirve para comprobar el orden de los lotes).
function numbered(text: string): number[] {
  const n = Number(/(\d+)$/.exec(text)?.[1] ?? 0);
  return vector(DIM, (index) => (index === 0 ? n + 1 : index === 1 ? 1 : 0));
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err: unknown) {
    return err instanceof EmbeddingError ? err.code : "OTHER";
  }
}

async function codeOfAsync(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err: unknown) {
    return err instanceof EmbeddingError ? err.code : "OTHER";
  }
}

type DimensionedRequest = EmbedContentRequest & { outputDimensionality?: number };

// Modelo simulado: responde a cada texto con lo que devuelve `respond` y registra las peticiones.
function fakeModel(
  respond: (text: string) => unknown = numbered,
  options: { failWith?: Error; dropLast?: boolean } = {}
) {
  const calls = { single: [] as DimensionedRequest[], batches: [] as BatchEmbedContentsRequest[] };
  const textOf = (request: EmbedContentRequest) => request.content.parts.map((part) => part.text ?? "").join("");
  const port: EmbeddingModelPort = {
    async embedContent(request) {
      calls.single.push(request);
      if (options.failWith) throw options.failWith;
      return { embedding: { values: respond(textOf(request)) as number[] } };
    },
    async batchEmbedContents(request) {
      calls.batches.push(request);
      if (options.failWith) throw options.failWith;
      const embeddings = request.requests.map((item) => ({ values: respond(textOf(item)) as number[] }));
      return { embeddings: options.dropLast ? embeddings.slice(0, -1) : embeddings };
    },
  };
  return { port, calls };
}

function runConfig() {
  // Identificador explícito: el de producción y el que resulta de las variables de entorno.
  assert.equal(embeddingModelId(DEFAULT_EMBEDDING_CONFIG), "gemini-embedding-001:768");
  assert.deepEqual(
    readEmbeddingConfig({ GEMINI_EMBED_MODEL: "gemini-embedding-001", GEMINI_EMBED_DIM: "768" }),
    DEFAULT_EMBEDDING_CONFIG
  );
  assert.deepEqual(readEmbeddingConfig({}), DEFAULT_EMBEDDING_CONFIG);
  assert.deepEqual(readEmbeddingConfig({ GEMINI_EMBED_MODEL: " ", GEMINI_EMBED_DIM: "" }), DEFAULT_EMBEDDING_CONFIG);

  // Otro modelo lleva otra etiqueta: sus vectores nunca se comparan con los de producción.
  assert.equal(
    embeddingModelId(readEmbeddingConfig({ GEMINI_EMBED_MODEL: "text-embedding-004" })),
    "text-embedding-004:768"
  );

  // Un tamaño distinto de vector(768) es un error de configuración, también al crear el motor.
  for (const dim of ["3072", "1536", "abc", "768.5"]) {
    assert.equal(codeOf(() => readEmbeddingConfig({ GEMINI_EMBED_DIM: dim })), "CONFIG", dim);
  }
  assert.equal(
    codeOf(() => createEmbeddingEngine(fakeModel().port, { model: "gemini-embedding-001", dimension: 1536 })),
    "CONFIG"
  );
  assert.equal(codeOf(() => createEmbeddingEngine(fakeModel().port, { model: " ", dimension: DIM })), "CONFIG");
}

function runVectors() {
  {
    // 768 valores: misma dirección y norma 1.
    const raw = vector(DIM);
    const unit = toStoredEmbedding(raw, DIM);
    const norm = vectorNorm(raw);
    assert.equal(unit.length, DIM);
    assert.ok(isStoredEmbedding(unit));
    unit.forEach((value, index) => assert.ok(Math.abs(value - raw[index] / norm) < 1e-12));
    assert.equal(isStoredEmbedding(raw), false, "sin normalizar no se guarda");

    // Normalizar uno ya normalizado no lo cambia.
    toStoredEmbedding(unit, DIM).forEach((value, index) => assert.ok(Math.abs(value - unit[index]) < 1e-12));
  }
  {
    // 3072 (la API ignoró outputDimensionality): se rechaza, no se recorta. Recortarlo sería otra
    // representación con la misma etiqueta; además el recorte de embedText no normaliza: el prefijo
    // de un vector de norma 1 queda por debajo de 1.
    const native = unitOf(vector(GEMINI_EMBEDDING_NATIVE_DIM, (index) => Math.sin(index + 1)));
    assert.equal(codeOf(() => toStoredEmbedding(native, DIM)), "DIMENSION_MISMATCH");
    assert.ok(vectorNorm(native.slice(0, DIM)) < 0.99);
  }
  {
    // Tamaños y valores inválidos.
    for (const length of [0, 767, 769, 1536, 3071, 3072]) {
      assert.equal(codeOf(() => toStoredEmbedding(vector(length), DIM)), "DIMENSION_MISMATCH", String(length));
    }
    assert.equal(codeOf(() => toStoredEmbedding(null, DIM)), "INVALID_VECTOR");
    assert.equal(codeOf(() => toStoredEmbedding("1,2,3", DIM)), "INVALID_VECTOR");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "0.5", null]) {
      const values: unknown[] = vector(DIM);
      values[10] = bad;
      assert.equal(codeOf(() => toStoredEmbedding(values, DIM)), "INVALID_VECTOR", String(bad));
    }
    assert.equal(codeOf(() => toStoredEmbedding(vector(DIM, () => 0), DIM)), "ZERO_VECTOR");
    // Valores enormes: la norma se desborda y el vector no se puede normalizar.
    assert.equal(codeOf(() => toStoredEmbedding(vector(DIM, () => 1e200), DIM)), "INVALID_VECTOR");
  }
}

async function runEngine() {
  {
    // Consulta: RETRIEVAL_QUERY, 768 dimensiones pedidas, texto sin espacios en los bordes.
    const { port, calls } = fakeModel();
    const engine = createEmbeddingEngine(port, DEFAULT_EMBEDDING_CONFIG);
    assert.equal(engine.modelId, "gemini-embedding-001:768");
    assert.equal(engine.dimension, DIM);

    assert.ok(isStoredEmbedding(await engine.embedQuery("  ¿Qué es el balanceo de línea?  ")));
    assert.equal(calls.single.length, 1);
    assert.equal(calls.single[0].taskType, TaskType.RETRIEVAL_QUERY);
    assert.equal(calls.single[0].outputDimensionality, DIM);
    assert.deepEqual(calls.single[0].content, { role: "user", parts: [{ text: "¿Qué es el balanceo de línea?" }] });

    // Una consulta larga se recorta como en embedText; una vacía no llega a Gemini.
    await engine.embedQuery("a".repeat(MAX_EMBED_INPUT_CHARS + 500));
    assert.equal(calls.single[1].content.parts[0].text?.length, MAX_EMBED_INPUT_CHARS);
    assert.equal(await codeOfAsync(engine.embedQuery("   ")), "EMPTY_INPUT");
    assert.equal(calls.single.length, 2);
  }
  {
    // Documento: RETRIEVAL_DOCUMENT. Un fragmento largo no se recorta: se rechaza sin llamar.
    const { port, calls } = fakeModel();
    const engine = createEmbeddingEngine(port, DEFAULT_EMBEDDING_CONFIG);
    assert.ok(isStoredEmbedding(await engine.embedDocument("El muestreo de trabajo estima proporciones.")));
    assert.equal(calls.single[0].taskType, TaskType.RETRIEVAL_DOCUMENT);
    assert.equal(calls.single[0].outputDimensionality, DIM);
    assert.equal(await codeOfAsync(engine.embedDocument("b".repeat(MAX_EMBED_INPUT_CHARS + 1))), "INPUT_TOO_LONG");
    assert.equal(await codeOfAsync(engine.embedDocument("")), "EMPTY_INPUT");
    assert.equal(calls.single.length, 1);
  }
  {
    // La API devuelve 3072, otro tamaño o una respuesta sin vector: se rechaza. En un lote, un solo
    // vector de otro tamaño invalida el lote entero (no se devuelve la mitad).
    const native = unitOf(vector(GEMINI_EMBEDDING_NATIVE_DIM, (index) => Math.cos(index)));
    const engine = createEmbeddingEngine(fakeModel(() => native).port, DEFAULT_EMBEDDING_CONFIG);
    assert.equal(await codeOfAsync(engine.embedQuery("x")), "DIMENSION_MISMATCH");
    const mixed = createEmbeddingEngine(
      fakeModel((text) => (text === "b" ? native : numbered(text))).port,
      DEFAULT_EMBEDDING_CONFIG
    );
    assert.equal(await codeOfAsync(mixed.embedDocuments(["a", "b", "c"])), "DIMENSION_MISMATCH");

    const wrong = createEmbeddingEngine(fakeModel(() => vector(1536)).port, DEFAULT_EMBEDDING_CONFIG);
    assert.equal(await codeOfAsync(wrong.embedQuery("x")), "DIMENSION_MISMATCH");
    const empty = createEmbeddingEngine(fakeModel(() => undefined).port, DEFAULT_EMBEDDING_CONFIG);
    assert.equal(await codeOfAsync(empty.embedDocument("x")), "INVALID_VECTOR");
  }
  {
    // Gemini falla: UPSTREAM con la causa original.
    const cause = new Error("429 Too Many Requests");
    const engine = createEmbeddingEngine(fakeModel(numbered, { failWith: cause }).port, DEFAULT_EMBEDDING_CONFIG);
    const isUpstream = (err: unknown) => err instanceof EmbeddingError && err.code === "UPSTREAM" && err.cause === cause;
    await assert.rejects(engine.embedQuery("x"), isUpstream);
    await assert.rejects(engine.embedDocuments(["a"]), isUpstream);

    // Qué se reintenta: límite de solicitudes, error del servicio o sin respuesta; no un pedido
    // inválido ni un vector incompatible.
    const upstream = (status?: number) =>
      new EmbeddingError("UPSTREAM", "x", { cause: Object.assign(new Error("x"), status === undefined ? {} : { status }) });
    assert.equal(isRetryableEmbeddingError(upstream(429)), true);
    assert.equal(isRetryableEmbeddingError(upstream(503)), true);
    assert.equal(isRetryableEmbeddingError(upstream(500)), true);
    assert.equal(isRetryableEmbeddingError(upstream()), true, "sin respuesta (red)");
    assert.equal(isRetryableEmbeddingError(upstream(400)), false);
    assert.equal(isRetryableEmbeddingError(upstream(403)), false);
    assert.equal(isRetryableEmbeddingError(new EmbeddingError("DIMENSION_MISMATCH", "x")), false);
    assert.equal(isRetryableEmbeddingError(new Error("x")), false);
  }
  {
    // Lotes: 250 fragmentos en 3 llamadas (100, 100 y 50), todos RETRIEVAL_DOCUMENT con 768, en orden.
    const { port, calls } = fakeModel();
    const engine = createEmbeddingEngine(port, DEFAULT_EMBEDDING_CONFIG);
    const texts = Array.from({ length: 250 }, (_, index) => `fragmento ${index}`);
    const vectors = await engine.embedDocuments(texts);

    assert.deepEqual(calls.batches.map((batch) => batch.requests.length), [100, 100, 50]);
    for (const batch of calls.batches) {
      for (const item of batch.requests as DimensionedRequest[]) {
        assert.equal(item.taskType, TaskType.RETRIEVAL_DOCUMENT);
        assert.equal(item.outputDimensionality, DIM);
      }
    }
    assert.equal(calls.single.length, 0);
    assert.equal(vectors.length, texts.length);
    vectors.forEach((embedding, index) => {
      assert.ok(isStoredEmbedding(embedding));
      assert.ok(Math.abs(embedding[0] / embedding[1] - (index + 1)) < 1e-9, `orden del fragmento ${index}`);
    });
  }
  {
    // Sin fragmentos no hay llamadas; uno vacío o largo frena el lote antes de la primera llamada.
    const { port, calls } = fakeModel();
    const engine = createEmbeddingEngine(port, DEFAULT_EMBEDDING_CONFIG);
    assert.deepEqual(await engine.embedDocuments([]), []);
    assert.equal(await codeOfAsync(engine.embedDocuments(["a", "  ", "c"])), "EMPTY_INPUT");
    assert.equal(await codeOfAsync(engine.embedDocuments(["a", "x".repeat(MAX_EMBED_INPUT_CHARS + 1)])), "INPUT_TOO_LONG");
    assert.equal(calls.batches.length, 0);

    // Si llegan menos embeddings que los pedidos, ninguno se asigna a un fragmento equivocado.
    const short = createEmbeddingEngine(fakeModel(numbered, { dropLast: true }).port, DEFAULT_EMBEDDING_CONFIG);
    assert.equal(await codeOfAsync(short.embedDocuments(["a", "b"])), "BATCH_MISMATCH");
  }
}

async function runSdkRequest() {
  // El SDK real, con fetch interceptado (sin red): el motor acepta su GenerativeModel tal cual y
  // outputDimensionality y taskType viajan en el cuerpo de embedContent y batchEmbedContents.
  const sent: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body: unknown = JSON.parse(String(init?.body ?? "null"));
    sent.push({ url, body });
    const values = vector(DIM);
    const payload = url.endsWith(":batchEmbedContents")
      ? { embeddings: (body as { requests: unknown[] }).requests.map(() => ({ values })) }
      : { embedding: { values } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const model = new GoogleGenerativeAI("clave-de-prueba").getGenerativeModel({ model: "gemini-embedding-001" });
    const engine = createEmbeddingEngine(model, DEFAULT_EMBEDDING_CONFIG);
    assert.ok(isStoredEmbedding(await engine.embedQuery("muestreo de trabajo")));
    assert.equal((await engine.embedDocuments(["guía 12", "guía 13"])).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sent.length, 2);
  assert.ok(sent[0].url.endsWith("/models/gemini-embedding-001:embedContent"), sent[0].url);
  assert.deepEqual(sent[0].body, {
    content: { role: "user", parts: [{ text: "muestreo de trabajo" }] },
    taskType: "RETRIEVAL_QUERY",
    outputDimensionality: DIM,
  });
  assert.ok(sent[1].url.endsWith("/models/gemini-embedding-001:batchEmbedContents"), sent[1].url);
  const batch = sent[1].body as { requests: Array<Record<string, unknown>> };
  assert.deepEqual(
    batch.requests.map((item) => [item.model, item.taskType, item.outputDimensionality]),
    [
      ["models/gemini-embedding-001", "RETRIEVAL_DOCUMENT", DIM],
      ["models/gemini-embedding-001", "RETRIEVAL_DOCUMENT", DIM],
    ]
  );
}

async function main() {
  runConfig();
  runVectors();
  await runEngine();
  await runSdkRequest();
  console.log("embeddingEngine tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
