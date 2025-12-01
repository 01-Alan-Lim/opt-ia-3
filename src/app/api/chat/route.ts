// src/app/api/chat/route.ts

// --------------------------------------
// 📌 IMPORTS
// --------------------------------------
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { getGeminiModel } from "@/lib/geminiClient";
import { embedText } from "@/lib/embeddings";

// --------------------------------------
// 📌 Tipos del mini-agente SQL
// --------------------------------------
type DbFilterOp = "eq" | "ilike";

interface DbFilter {
  column: string;
  op: DbFilterOp;
  value: string;
}

type DbTableName = "companies" | "method_engineering_experiences";

interface DbPlan {
  useDb: boolean;
  table: DbTableName;
  filters: DbFilter[];
  limit?: number;
  reason?: string;
}

// --------------------------------------
// 📌 Extraer JSON de la respuesta LLM
// --------------------------------------
function extractJsonFromText(text: string): string | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

// --------------------------------------
// 📌 2) Mini-agente: decidir qué consultar en DB
// --------------------------------------
async function planDbQuery(userMessage: string,
  history: string): Promise<DbPlan | null> {
  const model = getGeminiModel();

  const schemaDescription = `
Actúas como planificador de consultas SQL para una base de datos REAL de la Plataforma Aceleradora de Productividad.

Tienes acceso de SOLO LECTURA a estas tablas de Supabase:

1) method_engineering_experiences
   - id
   - codigo_id_de_la_empresa        (ID asignado por la Plataforma Aceleradora de Productividad)
   - nombre_o_razon_social_de_la_empresa
   - rubro                          (ej: textil, alimentos, servicios)
   - tamano_empresa                 (micro, pequeña, mediana, grande)
   - departamento
   - municipio
   - gestion
   - descripcion_mejora_planteada
   - implementacion_de_la_mejora
   - perspectivas_de_implementacion
   - causa_principal_1              (texto de causa raíz 1)
   - causa_principal_2              (texto de causa raíz 2)
   - causa_principal_3              (texto de causa raíz 3)
   (y otras columnas reales que NO necesitas mencionar una por una).

   Cada fila representa una experiencia de prácticas empresariales / ingeniería de métodos
   realizada por un estudiante en una empresa concreta.

2) companies                        (listado oficial de empresas de la Plataforma de Productividad)
   - id
   - id_empresa                     (ID oficial asignado por la Plataforma)
   - nombre_de_la_empresa           (nombre oficial de la empresa)

Reglas IMPORTANTE:
- La tabla "companies" SOLO tiene id_empresa y nombre_de_la_empresa como datos relevantes.
- NO inventes columnas como sector, ciudad o país.
- Si el usuario pregunta por "ID de la empresa", "id_empresa", "código de empresa" o similar,
  debes consultar SIEMPRE la tabla "companies".
- Si el usuario pregunta por causas raíz, causas principales, motivos del problema, etc.,
  debes usar la tabla "method_engineering_experiences" y aprovechar las columnas
  causa_principal_1, causa_principal_2 y causa_principal_3.
- Si pregunta por:
    * en qué empresas se aplicó una mejora,
    * dónde se hizo balanceo de línea,
    * experiencias de prácticas empresariales o de ingeniería de métodos,
  entonces debes usar la tabla "method_engineering_experiences" y filtrar por palabras clave
  en columnas como "descripcion_mejora_planteada" o "implementacion_de_la_mejora".


  USO DEL HISTORIAL:

- Se te proporciona el historial reciente de la conversación (usuario y asistente).
- Si el mensaje ACTUAL del usuario es una repregunta del tipo:
  "¿y en la gestión II/2024?", "¿y en el siguiente semestre?", "¿y qué causas se encontraron esa gestión?",
  debes asumir que se refiere A LA MISMA EMPRESA mencionada en la pregunta anterior,
  **a menos que el usuario especifique claramente otra empresa**.
- Por ejemplo:
  - Si en el historial aparece una pregunta sobre la empresa ISOCRET,
    y a continuación el usuario pregunta solo "¿y en la gestión II/2024?",
    entonces DEBES filtrar por la misma empresa ISOCRET (por nombre o por código),
    y por gestion = 'II/2024'.
- No mezcles varias empresas en la misma respuesta si el usuario está hablando de una sola.
  Solo consultes varias empresas si el usuario lo pide explícitamente ("en varias empresas", "en todas", etc.).


Reglas generales:
- SOLO puedes usar las tablas: "companies" o "method_engineering_experiences".
- SOLO puedes usar filtros con operadores "eq" o "ilike".
- Máximo "limit" = 50.
- Devuelve SIEMPRE un JSON con esta forma:

{
  "useDb": true | false,
  "table": "companies" | "method_engineering_experiences",
  "filters": [ { "column": "...", "op": "eq" | "ilike", "value": "..." } ],
  "limit": 10,
  "reason": "explicación corta en español"
}

Si NO ves una forma clara de usar la base de datos, responde con:
{ "useDb": false, "table": "method_engineering_experiences", "filters": [], "limit": 0, "reason": "..." }.
`;

  const prompt = `${schemaDescription}
Tienes acceso también al siguiente historial resumido de la conversación
(ordenado cronológicamente):

"""${history}"""

Instrucciones clave:

- Usa el HISTORIAL para entender a qué empresa, mejora o problema se refiere
  la pregunta actual.
- Si la pregunta actual es corta o ambigua (por ejemplo: "¿en qué gestión?",
  "¿qué mejoras se hicieron?", "¿en qué semestre fue?"), asume que se refiere
  al tema del mensaje anterior del usuario y/o a la última empresa mencionada.
- Si recientemente se mencionó una empresa concreta (por nombre o por ID de
  plataforma), úsala como filtro en la tabla adecuada.

Ahora, a partir de este mensaje ACTUAL del usuario, decide si hay que consultar
la base de datos y construye el JSON:

Mensaje actual del usuario:

"""${userMessage}"""
`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const text = result.response.text();
  const jsonStr = extractJsonFromText(text);
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed.useDb !== "boolean") return null;

    if (!parsed.table) parsed.table = "method_engineering_experiences";
    if (!Array.isArray(parsed.filters)) parsed.filters = [];
    if (parsed.limit && parsed.limit > 50) parsed.limit = 50;

    return parsed as DbPlan;
  } catch {
    console.error("No se pudo parsear DbPlan:", text);
    return null;
  }
}

// --------------------------------------
// 📌 3) Ejecutar plan SQL en Supabase
// --------------------------------------
async function runDbPlan(plan: DbPlan): Promise<any[] | null> {
  let query;

  if (plan.table === "companies") {
    query = supabase.from("companies").select("*");
  } else {
    query = supabase.from("method_engineering_experiences").select("*");
  }

  for (const f of plan.filters || []) {
    if (!f.column || !f.op) continue;

    if (f.op === "eq") {
      query = query.eq(f.column, f.value);
    } else if (f.op === "ilike") {
      query = query.ilike(f.column, `%${f.value}%`);
    }
  }

  const limit = plan.limit && plan.limit > 0 ? plan.limit : 20;
  query = query.limit(limit);

  const { data, error } = await query;

  if (error) {
    console.error("Error ejecutando consulta DB:", error);
    return null;
  }
  console.log("🔎 DB rows devueltos por runDbPlan:", data); // 👈 IMPORTANTE

  return data ?? [];
}

// --------------------------------------
// 📌 4) Construir texto con los resultados SQL
// --------------------------------------
function buildDbContext(table: DbTableName, rows: any[]): string {
  if (!rows.length) return "";

  // 🏢 Tabla companies: responder ID oficial de la Plataforma
  if (table === "companies") {
    return rows
      .map((row: any, i: number) => {
        const nombre = row.nombre_de_la_empresa ?? "Empresa sin nombre";
        const idEmpresa = row.id_empresa ?? "";

        return `(${i + 1}) ${nombre}${
          idEmpresa ? ` – ID plataforma: ${idEmpresa}` : ""
        }`;
      })
      .join("\n");
  }

  // method_engineering_experiences
  return rows
    .map((row: any, i: number) => {
      const empresa =
        row.nombre_o_razon_social_de_la_empresa ??
        row.nombre_de_la_empresa ??
        "Empresa sin nombre";

      const codigo =
        row.codigo_id_de_la_empresa ??
        row.id_empresa ??
        "";

      const gestion = row.gestion ?? "gestión no especificada";
      const rubro = row.rubro ?? "rubro no especificado";
      const size = row.tamano_empresa ?? "tamaño no especificado";

      const ubicacion = [row.municipio, row.departamento]
        .filter(Boolean)
        .join(", ");

      const desc = row.descripcion_mejora_planteada ?? "";

      const estado =
        row.implementacion_de_la_mejora ??
        row.perspectivas_de_implementacion ??
        "";

      const causasArray = [
        row.causa_principal_1,
        row.causa_principal_2,
        row.causa_principal_3,
       ].filter((c: string | null | undefined) => !!c && c.trim().length > 0);

       const causasTexto = causasArray
        .map((c: string, idx: number) => `${idx + 1}. "${c.trim()}"`)
        .join(" ");


      return `(${i + 1}) ${empresa}${
        codigo ? ` [ID ${codigo}]` : ""
      } – Gestión: ${gestion || "sin dato"}. ${rubro || "sin rubro"}${
        size ? `, tamaño ${size}` : ""
      }${ubicacion ? `, ${ubicacion}` : ""}. Mejora registrada: ${
        desc || "sin descripción"
      }${estado ? `. Estado/implementación: ${estado}` : "" 
    }${
      causasArray.length
        ? `\nCausas raíz REGISTRADAS EN LA BASE DE DATOS (texto literal, no interpretar): ${causasTexto}`
       : "" 
    }`;
    })
    .join("\n\n");
}

// --------------------------------------
// 📌 HANDLER PRINCIPAL POST
// --------------------------------------
export async function POST(request: Request) {
  const body = await request.json();
  const userMessage: string = body.message ?? "";
  const incomingChatId: string | null = body.chatId ?? null;

  // 🔑 usar el userId que viene del front para la tabla chats
  const clientId: string = body.userId ?? "anon";

  if (!userMessage.trim()) {
    return NextResponse.json({ error: "Mensaje vacío" }, { status: 400 });
  }

  let chatId = incomingChatId;

  // Crear nuevo chat si no existe
  if (!chatId) {
    const { data, error } = await supabase
      .from("chats")
      .insert({
        client_id: clientId, // guardamos el userId de Privy
        title: userMessage.slice(0, 60),
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("Error creando chat:", error);
      return NextResponse.json(
        { error: "No se pudo crear el chat" },
        { status: 500 }
      );
    }

    chatId = data.id as string;
  }

  // Guardar mensaje usuario
  await supabase.from("messages").insert({
    chat_id: chatId,
    role: "user",
    content: userMessage,
  });

  // Leer historial
  const { data: historyData } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(12);

  const historyText =
    historyData
      ?.map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.content}`)
      .join("\n") ?? "";

  // --------------------------------------
  // 4a) MINI-AGENTE SQL
  // --------------------------------------
  let dbContext = "";
  try {
    const dbPlan = await planDbQuery(userMessage, historyText);
    if (dbPlan && dbPlan.useDb) {
      const rows = await runDbPlan(dbPlan);
      if (rows && rows.length > 0) {
        dbContext = buildDbContext(dbPlan.table, rows);
      }
    }
  } catch (e) {
    console.error("Error en mini-agente SQL:", e);
  }

  // --------------------------------------
  // 5) RAG documentos (embeddings)
  // --------------------------------------
  let docsContext = "";
  try {
    const embedding = await embedText(userMessage);

    const { data: matches } = await supabase.rpc("match_document_chunks", {
      query_embedding: embedding,
      match_count: 5,
    });

    if (matches) {
      docsContext = matches
        .map((m: any, i: number) => `(${i + 1}) ${m.content}`)
        .join("\n");
    }
  } catch (e) {
    console.error("Error en RAG match_document_chunks:", e);
  }

  // --------------------------------------
  // 6) Llamar al modelo LLM
  // --------------------------------------
  let replyText = "";
  try {
    const model = getGeminiModel();

    const parts: string[] = [];

    parts.push(`
Eres OPT-IA, un asistente especializado en apoyar a estudiantes de Ingeniería Industrial
y a micro y pequeñas empresas (MyPEs).

Reglas IMPORTANTES al usar el contexto:
- No inventes datos de base de datos ni causes raíz.
- Si el contexto de base de datos incluye una línea que dice
  "Causas raíz REGISTRADAS EN LA BASE DE DATOS (texto literal, no interpretar): ...",
  entonces debes COPIAR literalmente esos textos cuando el usuario pregunte por causas
  raíz o causas principales. No los reformules ni agregues causas nuevas.
- Si no hay causas raíz registradas, dilo explícitamente.
- Puedes explicar o interpretar después, pero primero menciona siempre las causas
  exactamente como están almacenadas.

PUEDES usar:
- Tu conocimiento general sobre MyPEs, productividad, ingeniería de métodos, etc.
- El contexto de experiencias (base de datos) y documentos que se te proporciona.

PERO TIENES PROHIBIDO:
- Mencionar o describir "los documentos", "los PDFs", "los documentos que me proporcionaste",
  "los documentos indexados", "el contexto de documentos" o frases similares.
- Mencionar o describir "el contexto de base de datos", "la base de datos que poseo" o
  "mi acceso a la base de datos".
- Decir frases tipo:
  - "Como he comentado anteriormente..."
  - "Como mencioné en mis respuestas anteriores..."
  - "Los documentos que me proporcionaste están centrados en..."
  - "No encuentro en los documentos un caso específico..."
  ni variaciones de esto.
- Justificar tus límites o hablar de lo que sabes o no sabes.

EN SU LUGAR:
- Responde SIEMPRE de forma directa, como un asesor que tiene contexto suficiente.
- Si la pregunta pide ejemplos de empresas, usa la información del contexto que recibes,
  y si no hay un caso exacto, crea un ejemplo ilustrativo y realista basado en buenas prácticas,
  dejando claro que es un ejemplo ilustrativo, pero SIN mencionar documentos ni bases de datos.
- Puedes usar nombres de empresas que aparezcan en el contexto (por ejemplo, del listado de empresas),
  pero no inventes datos numéricos exactos (ventas, montos, etc.) salvo que sea necesario y claramente
  aproximado.
- Sé claro, conciso y enfocado en ayudar al usuario a tomar decisiones o entender el concepto.
`);

    parts.push("\nHistorial:\n" + historyText);

    if (docsContext) {
      parts.push(
        "\nContexto de documentos:\n" +
          docsContext +
          "\n(Usar solo si es relevante)"
      );
    }

    if (dbContext) {
      parts.push(
        "\nContexto de base de datos:\n" +
          dbContext +
          "\n(Usar solo si la pregunta lo requiere)"
      );
    }

    parts.push("\nPregunta del usuario:\n" + userMessage);

    const res = await model.generateContent(parts);
    replyText = res.response.text();
  } catch (e) {
    console.error("Error llamando a Gemini:", e);
    replyText = "Hubo un problema al generar la respuesta.";
  }

  // Guardar respuesta del asistente
  await supabase.from("messages").insert({
    chat_id: chatId,
    role: "assistant",
    content: replyText,
  });

  return NextResponse.json({ reply: replyText, chatId });
}
