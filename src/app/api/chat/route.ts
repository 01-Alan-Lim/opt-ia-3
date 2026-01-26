// src/app/api/chat/route.ts
// Endpoint principal del chat.

import { NextResponse } from "next/server";
import { z } from "zod";

import { supabaseServer } from "@/lib/supabaseServer";
import { requireUser } from "@/lib/auth/supabase";
import { ok, fail } from "@/lib/api/response";

import { detectFormIntent } from "@/lib/chat/formIntents";

import { assertChatAccess } from "@/lib/auth/chatAccess";

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
// ✅ Validación de payload (técnico)
// --------------------------------------
const ChatBodySchema = z.object({
  message: z.string().trim().min(1, "Mensaje vacío"),
  chatId: z.string().uuid().nullable().optional(),
  mode: z.string().optional(), // mantenemos flexible, como estaba
});

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
// 📌 Detectar si el usuario quiere "ID/empresa oficial" y/o "experiencias/mejoras/causas"
// (determinista, sin tocar el prompt del planner)
// --------------------------------------
function detectDualDbNeed(message: string): { needsCompanies: boolean; needsExperiences: boolean } {
  const m = message.toLowerCase();

  // señales de "companies"
  const wantsId =
    /\b(id|id_empresa|identificador|código|codigo|id de la empresa|id plataforma|plataforma)\b/.test(m);

  // señales de "experiences"
  const wantsExperiences =
    /\b(mejora|mejoras|causa|causas|causa raíz|causas raíz|práctica|practicas|experiencia|experiencias|implementación|implementacion|perspectivas)\b/.test(
      m
    );

  return { needsCompanies: wantsId, needsExperiences: wantsExperiences };
}

// --------------------------------------
// 📌 2) Mini-agente: decidir qué consultar en DB
// (PROMPT INTACTO)
// --------------------------------------
async function planDbQuery(userMessage: string, history: string): Promise<DbPlan | null> {
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
// (técnico: usar supabaseServer)
// --------------------------------------
async function runDbPlan(plan: DbPlan): Promise<any[] | null> {
  let query;

  if (plan.table === "companies") {
    query = supabaseServer.from("companies").select("*");
  } else {
    query = supabaseServer.from("method_engineering_experiences").select("*");
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
  console.log("🔎 DB rows devueltos por runDbPlan:", data);

  return data ?? [];
}

// --------------------------------------
// 📌 3b) Enriquecer experiences con companies (join lógico)
// (técnico: sigue siendo server-side con supabaseServer)
// --------------------------------------
type CompanyLite = { id_empresa: string; nombre_de_la_empresa: string | null };

async function fetchCompaniesByIds(ids: string[]): Promise<Map<string, CompanyLite>> {
  const unique = Array.from(new Set(ids.map((x) => x.trim()).filter(Boolean)));
  const map = new Map<string, CompanyLite>();
  if (!unique.length) return map;

  const { data, error } = await supabaseServer
    .from("companies")
    .select("id_empresa, nombre_de_la_empresa")
    .in("id_empresa", unique);

  if (error) {
    console.error("Error leyendo companies para enrich:", error);
    return map;
  }

  for (const row of data ?? []) {
    if (!row?.id_empresa) continue;
    map.set(row.id_empresa, {
      id_empresa: row.id_empresa,
      nombre_de_la_empresa: row.nombre_de_la_empresa ?? null,
    });
  }

  return map;
}

async function fetchCompaniesByNameLike(name: string, limit = 10): Promise<any[] | null> {
  const q = name.trim();
  if (!q) return null;

  const { data, error } = await supabaseServer
    .from("companies")
    .select("id_empresa, nombre_de_la_empresa")
    .ilike("nombre_de_la_empresa", `%${q}%`)
    .limit(limit);

  if (error) {
    console.error("Error leyendo companies por nombre (fallback):", error);
    return null;
  }
  return data ?? [];
}

function pickCompanyNameFromExperienceRows(rows: any[]): string | null {
  for (const r of rows) {
    const name = typeof r?.nombre_o_razon_social_de_la_empresa === "string" ? r.nombre_o_razon_social_de_la_empresa : "";
    const trimmed = name.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// --------------------------------------
// 📌 4) Construir texto con los resultados SQL
// (sin cambios funcionales)
// --------------------------------------
function buildDbContext(
  table: DbTableName,
  rows: any[],
  companiesById?: Map<string, CompanyLite>
): string {

  if (!rows.length) return "";

  if (table === "companies") {
    return rows
      .map((row: any, i: number) => {
        const nombre = row.nombre_de_la_empresa ?? "Empresa sin nombre";
        const idEmpresa = row.id_empresa ?? "";

        return `(${i + 1}) ${nombre}${idEmpresa ? ` – ID plataforma: ${idEmpresa}` : ""}`;
      })
      .join("\n");
  }

  return rows
    .map((row: any, i: number) => {
      const empresa =
        row.nombre_o_razon_social_de_la_empresa ??
        row.nombre_de_la_empresa ??
        "Empresa sin nombre";

      const codigo = row.codigo_id_de_la_empresa ?? row.id_empresa ?? "";
      const official = codigo && companiesById ? companiesById.get(codigo) : null;
      const officialText =
        official && (official.nombre_de_la_empresa || official.id_empresa)
          ? ` (oficial: ${official.nombre_de_la_empresa ?? "sin nombre"}${official.id_empresa ? ` – ID ${official.id_empresa}` : ""})`
          : "";
      const gestion = row.gestion ?? "gestión no especificada";
      const rubro = row.rubro ?? "rubro no especificado";
      const size = row.tamano_empresa ?? "tamaño no especificado";

      const ubicacion = [row.municipio, row.departamento].filter(Boolean).join(", ");
      const desc = row.descripcion_mejora_planteada ?? "";

      const estado = row.implementacion_de_la_mejora ?? row.perspectivas_de_implementacion ?? "";

      const causasArray = [row.causa_principal_1, row.causa_principal_2, row.causa_principal_3].filter(
        (c: string | null | undefined) => !!c && c.trim().length > 0
      );

      const causasTexto = causasArray
        .map((c: string, idx: number) => `${idx + 1}. "${c.trim()}"`)
        .join(" ");

      return `(${i + 1}) ${empresa}${codigo ? ` [ID ${codigo}]` : ""}${officialText} – Gestión: ${
        gestion || "sin dato"
      }. ${rubro || "sin rubro"}${size ? `, tamaño ${size}` : ""}${
        ubicacion ? `, ${ubicacion}` : ""
      }. Mejora registrada: ${desc || "sin descripción"}${
        estado ? `. Estado/implementación: ${estado}` : ""
      }${
        causasArray.length
          ? `\nCausas raíz REGISTRADAS EN LA BASE DE DATOS (texto literal, no interpretar): ${causasTexto}`
          : ""
      }`;
    })
    .join("\n\n");
}

// --------------------------------------
// ✅ Ownership check (técnico)
// --------------------------------------
async function assertChatOwnership(chatId: string, userId: string) {
  const { data, error } = await supabaseServer
    .from("chats")
    .select("id, client_id, mode")
    .eq("id", chatId)
    .single();

  if (error || !data) throw new Error("CHAT_NOT_FOUND");
  if (data.client_id !== userId) throw new Error("FORBIDDEN_CHAT");

  return { mode: (data.mode as string | null) ?? null };
}

// --------------------------------------
// 📌 HANDLER PRINCIPAL POST
// --------------------------------------
export async function POST(request: Request) {
  try {
    // ✅ Auth server-side
    const authed = await requireUser(request);

    // ✅ Gate server-side (fuente de verdad: perfil/fechas)
    const gate = await assertChatAccess(request);
    if (!gate.ok) {
      return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });
    }

    // ✅ Parse seguro del JSON
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(fail("BAD_REQUEST", "Body JSON inválido."), { status: 400 });

    }

    const parsed = ChatBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const userMessage = parsed.data.message;
    const incomingChatId = parsed.data.chatId ?? null;

    // 👇 Mantenemos el modo como estaba (default "general")
    const mode: string = parsed.data.mode ?? "general";

    let chatId = incomingChatId;

    // Crear nuevo chat si no existe (ownership = authed.userId)
    if (!chatId) {
      const { data, error } = await supabaseServer
        .from("chats")
        .insert({
          client_id: authed.userId, // ✅ ya no viene del front
          title: userMessage.slice(0, 60),
          mode, // ✅ mantenemos tu lógica de guardar modo
        })
        .select("id")
        .single();

      if (error || !data) {
        console.error("Error creando chat:", error);
        return NextResponse.json(fail("INTERNAL", "No se pudo crear el chat"), { status: 500 });

      }

      chatId = data.id as string;
    } else {
      // ✅ Si chatId existe, validar ownership (evita leer/escribir chats ajenos)
      const owned = await assertChatOwnership(chatId, authed.userId);

      // Obtener modo real del chat desde la BD (como tu lógica original)
      if (owned.mode) {
        // si existe, reemplazamos "mode" local con el de la BD
        // (para mantener tu comportamiento original)
      }
    }

    // Obtener modo real del chat desde la BD (manteniendo tu intención original)
    let chatMode = mode;
    try {
      const { data: chatRow } = await supabaseServer
        .from("chats")
        .select("mode, client_id")
        .eq("id", chatId)
        .single();

      // ✅ seguridad extra: si por alguna razón no coincide, bloqueamos
      if (!chatRow || chatRow.client_id !== authed.userId) {
        return NextResponse.json(fail("FORBIDDEN", "No tienes acceso a este chat."), { status: 403 });
      }

      if (chatRow?.mode) {
        chatMode = chatRow.mode;
      }
    } catch (e) {
      console.error("No se pudo obtener el modo del chat:", e);
    }

    // Guardar mensaje usuario
    {
      const { error } = await supabaseServer.from("messages").insert({
        chat_id: chatId,
        role: "user",
        content: userMessage,
      });

      if (error) {
        console.error("Error guardando mensaje usuario:", error);
        return NextResponse.json(fail("INTERNAL", "No se pudo guardar el mensaje."), { status: 500 });

      }
    }

    // Leer historial
    const { data: historyData, error: historyError } = await supabaseServer
      .from("messages")
      .select("role, content, created_at")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true })
      .limit(12);

    if (historyError) {
      console.error("Error leyendo historial:", historyError);
      return NextResponse.json(fail("INTERNAL", "No se pudo leer el historial."), { status: 500 });

    }

    const historyText =
      historyData
        ?.map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.content}`)
        .join("\n") ?? "";

    // --------------------------------------
    // ✅ 4) INTENCIONES: Formularios (inicial/mensual/final)
    // Intercepta antes de mini-agente SQL / RAG / Gemini
    // --------------------------------------
    try {
      // Solo en modo general (el plan_mejora luego tendrá su propio flujo)
      if (chatMode !== "plan_mejora") {
        // Detectar si el mensaje anterior del asistente fue la pregunta de aclaración
        const lastAssistantMsg = [...(historyData ?? [])]
          .reverse()
          .find((m) => m.role === "assistant")?.content ?? "";

        const wasClarifying =
          lastAssistantMsg.includes("¿Cuál formulario necesitas?") &&
          lastAssistantMsg.includes("Inicial") &&
          lastAssistantMsg.includes("Mensual") &&
          lastAssistantMsg.includes("Final");

        // Si NO venimos de aclaración, evitamos que respuestas cortas tipo "inicial"
        // se activen por accidente (solo dejamos pasar si el usuario también menciona "formulario" o "form")
        const rawIntent = detectFormIntent(userMessage);

        const isShortChoice =
          rawIntent.kind === "FORM_INITIAL" || rawIntent.kind === "FORM_MONTHLY" || rawIntent.kind === "FORM_FINAL";

        const intent =
          wasClarifying
            ? rawIntent
            : isShortChoice && !(userMessage.toLowerCase().includes("form") || userMessage.toLowerCase().includes("formulario"))
              ? { kind: "NONE" as const }
              : rawIntent;


        if (intent.kind !== "NONE") {
          // Leer perfil (cohort_id + estado) para resolver links
          const { data: profile, error: profErr } = await supabaseServer
            .from("profiles")
            .select("user_id, role, registration_status, cohort_id")
            .eq("user_id", authed.userId)
            .single();

          if (profErr || !profile) {
            return NextResponse.json(fail("INTERNAL", "No se pudo leer tu perfil."), { status: 500 });
          }
          if (!profile) {
            const reply =
              "No encuentro tu perfil en el sistema. Ve a /onboarding para completar tu registro, o contacta a tu docente.";
            await supabaseServer.from("messages").insert({ chat_id: chatId, role: "assistant", content: reply });
            return ok({ reply, chatId });
          }

          // assertChatAccess ya filtró la mayoría de gates, pero reforzamos:
          if (profile.role !== "student") {
            const reply = "Los formularios están disponibles solo para estudiantes.";
            await supabaseServer.from("messages").insert({ chat_id: chatId, role: "assistant", content: reply });
            return ok({ reply, chatId });
          }

          if (profile.registration_status !== "approved") {
            const reply =
              "Aún no puedes solicitar formularios porque tu cuenta no está aprobada. Cuando tu docente apruebe tu registro podrás acceder.";
            await supabaseServer.from("messages").insert({ chat_id: chatId, role: "assistant", content: reply });
            return ok({ reply, chatId });
          }

          if (!profile.cohort_id) {
            const reply =
              "Aún no tienes cohorte asignada. Pídele a tu docente que te asigne a una cohorte para habilitar formularios.";
            await supabaseServer.from("messages").insert({ chat_id: chatId, role: "assistant", content: reply });
            return ok({ reply, chatId });
          }

          // Traer links desde cohorts
          const { data: cohort, error: cohortErr } = await supabaseServer
            .from("cohorts")
            .select("form_initial_url, form_monthly_url, form_final_url")
            .eq("id", profile.cohort_id)
            .single();

          if (cohortErr || !cohort) {
            return NextResponse.json(fail("INTERNAL", "No se pudo leer la configuración de tu cohorte."), {
              status: 500,
            });
          }

          if (intent.kind === "FORM_AMBIGUOUS") {
            const reply = "¿Cuál formulario necesitas? (Inicial / Mensual / Final)";
            await supabaseServer.from("messages").insert({ chat_id: chatId, role: "assistant", content: reply });
            return ok({ reply, chatId });
          }

          const url =
            intent.kind === "FORM_INITIAL"
              ? cohort.form_initial_url
              : intent.kind === "FORM_MONTHLY"
                ? cohort.form_monthly_url
                : cohort.form_final_url;

          if (!url) {
            const which =
              intent.kind === "FORM_INITIAL"
                ? "inicial"
                : intent.kind === "FORM_MONTHLY"
                  ? "mensual"
                  : "final";

            const reply = `Aún no tengo configurado el link del formulario ${which} para tu cohorte. Pídele a tu docente que lo cargue en el panel.`;
            await supabaseServer.from("messages").insert({ chat_id: chatId, role: "assistant", content: reply });
            return ok({ reply, chatId });
          }

          const label =
            intent.kind === "FORM_INITIAL"
              ? "formulario inicial"
              : intent.kind === "FORM_MONTHLY"
                ? "formulario mensual"
                : "formulario final";

          const reply = `Aquí tienes el ${label}:\n${url}`;
          await supabaseServer.from("messages").insert({ chat_id: chatId, role: "assistant", content: reply });
          return ok({ reply, chatId });
        }
      }
    } catch (e) {
      console.error("Error en intents de formularios:", e);
      // si falla, no rompemos el chat: continúa a SQL/RAG/Gemini
    }

    // --------------------------------------
    // 4a) MINI-AGENTE SQL (sin tocar prompts)
    // + Paso 4: doble consulta determinista cuando corresponde
    // --------------------------------------
    let dbContext = "";
    try {
      const need = detectDualDbNeed(userMessage);
      const dbPlan = await planDbQuery(userMessage, historyText);

      if (dbPlan && dbPlan.useDb) {
        const rows = await runDbPlan(dbPlan);

        // Contextos parciales (podemos combinar)
        let companiesContext = "";
        let experiencesContext = "";

        // 1) Si el plan principal es companies
        if (dbPlan.table === "companies") {
          if (rows && rows.length > 0) {
            companiesContext = buildDbContext("companies", rows);
          }

          // ✅ Paso 4: si además pidió mejoras/causas/experiencias, consultamos experiences por los IDs devueltos
          if (need.needsExperiences && rows && rows.length > 0) {
            const ids = rows
              .map((r: any) => (typeof r?.id_empresa === "string" ? r.id_empresa : ""))
              .map((x: string) => x.trim())
              .filter((x: string) => x.length > 0);

            if (ids.length > 0) {
              const expPlan: DbPlan = {
                useDb: true,
                table: "method_engineering_experiences",
                filters: [{ column: "codigo_id_de_la_empresa", op: "eq", value: ids[0] }],
                limit: 20,
                reason: "Paso 4: cruce determinista companies → experiences",
              };

              // Si hay varios IDs y quieres cubrir más de 1, necesitarías OR (no permitido en DbPlan),
              // así que MVP: tomamos el primero (lo más común: 1 empresa).
              const expRows = await runDbPlan(expPlan);

              if (expRows && expRows.length > 0) {
                const codes = expRows
                  .map((r: any) => (typeof r?.codigo_id_de_la_empresa === "string" ? r.codigo_id_de_la_empresa : ""))
                  .filter((x: string) => x.trim().length > 0);

                const companiesById = await fetchCompaniesByIds(codes);
                experiencesContext = buildDbContext("method_engineering_experiences", expRows, companiesById);
              }
            }
          }

          // Combinar: si pidió ID, damos prioridad a companies primero
          dbContext = [companiesContext, experiencesContext].filter(Boolean).join("\n\n");
        }

        // 2) Si el plan principal es experiences
        if (dbPlan.table === "method_engineering_experiences") {
          if (rows && rows.length > 0) {
            const codes = rows
              .map((r: any) => (typeof r?.codigo_id_de_la_empresa === "string" ? r.codigo_id_de_la_empresa : ""))
              .filter((x: string) => x.trim().length > 0);

            const companiesById = await fetchCompaniesByIds(codes);
            experiencesContext = buildDbContext("method_engineering_experiences", rows, companiesById);

            // ✅ Paso 4: si además pidió ID/empresa oficial y NO hubo match por código,
            // hacemos fallback por nombre (ilike) para intentar traer companies.
            const hadAnyCompanyMatch = companiesById.size > 0;

            if (need.needsCompanies && !hadAnyCompanyMatch) {
              const name = pickCompanyNameFromExperienceRows(rows);
              if (name) {
                const compRows = await fetchCompaniesByNameLike(name, 10);
                if (compRows && compRows.length > 0) {
                  companiesContext = buildDbContext("companies", compRows);
                }
              }
            }
          }

          // Combinar: si pidió ID, ponemos companies primero; si no, experiences primero.
          dbContext = need.needsCompanies
            ? [companiesContext, experiencesContext].filter(Boolean).join("\n\n")
            : [experiencesContext, companiesContext].filter(Boolean).join("\n\n");
        }
      }
    } catch (e) {
      console.error("Error en mini-agente SQL:", e);
    }

    // --------------------------------------
    // 5) RAG documentos (embeddings) (técnico: usar supabaseServer)
    // --------------------------------------
    let docsContext = "";
    try {
      const embedding = await embedText(userMessage);

      const { data: matches, error } = await supabaseServer.rpc("match_document_chunks", {
        query_embedding: embedding,
        match_count: 5,
        p_user_id: authed.userId,
      });

      if (error) {
        console.error("Error en RAG match_document_chunks:", error);
      }

      if (matches) {
        docsContext = matches.map((m: any, i: number) => `(${i + 1}) ${m.content}`).join("\n");
      }
    } catch (e) {
      console.error("Error en RAG match_document_chunks:", e);
    }

    // --------------------------------------
    // 6) Llamar al modelo LLM
    // (PROMPT INTACTO: mismo texto que tenías)
    // --------------------------------------
    let replyText = "";
    try {
      const model = getGeminiModel();

      const parts: string[] = [];

      // 👇 Prompt base según el modo del chat
      let systemPrompt = "";

      if (chatMode === "plan_mejora") {
        systemPrompt = `
Eres OPT-IA, un docente revisor de planes de mejora empresariales para estudiantes de Ingeniería Industrial.
Tu foco principal es:
- Guiar al estudiante en la formulación de su plan (diagnóstico, problema, causa raíz, objetivos, indicadores, actividades, cronograma, responsables, etc.).
- Detectar incoherencias, vacíos y errores frecuentes (objetivos mal formulados, indicadores poco claros, actividades que no atacan la causa raíz, etc.).
- Dar retroalimentación clara y concreta, con sugerencias de mejora y ejemplos aplicados a micro y pequeñas empresas (MyPEs).
Siempre responde como si estuvieras revisando el borrador de un estudiante, con tono respetuoso pero crítico y orientado a la acción.
`;
      } else {
        // Modo GENERAL
        systemPrompt = `
Eres OPT-IA, un asistente general para estudiantes de Ingeniería Industrial y micro y pequeñas empresas (MyPEs).
Ayudas con:
- Dudas conceptuales de ingeniería, productividad y mejora continua.
- Ideas de mejora para MyPEs (procesos, organización, marketing básico, etc.).
- Explicaciones claras y ejemplos prácticos.
Responde de forma directa y útil, como un asesor que conoce tanto el contexto académico como el empresarial.
`;
      }

      // 👇 Reglas globales sobre uso de contexto (DB + documentos)
      systemPrompt += `
Reglas IMPORTANTES al usar el contexto:
- No inventes datos de base de datos ni causas raíz.
- Si el contexto de base de datos incluye una línea que dice
  "Causas raíz REGISTRADAS EN LA BASE DE DATOS (texto literal, no interpretar): ...",
  entonces debes COPIAR literalmente esos textos cuando el usuario pregunte por causas
  raíz o causas principales. No los reformules ni agregues causas nuevas.
- Si no hay causas raíz registradas, dilo explícitamente.
- Puedes explicar o interpretar después, pero primero menciona siempre las causas
  exactamente como están almacenadas.

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
  pero no inventes datos numéricos exactos (ventas, montos, etc.) salvo que sea necesario y claramente aproximado.
- Sé claro, conciso y enfocado en ayudar al usuario a tomar decisiones o entender el concepto.
`;

      parts.push(systemPrompt);

      parts.push("\nHistorial:\n" + historyText);

      if (docsContext) {
        parts.push("\nInformación de apoyo:\n" + docsContext);
      }

      if (dbContext) {
        parts.push("\nInformación de apoyo:\n" + dbContext);
      }


      parts.push("\nPregunta del usuario:\n" + userMessage);

      const res = await model.generateContent(parts);
      replyText = res.response.text();
    } catch (e) {
      console.error("Error llamando a Gemini:", e);
      replyText = "Hubo un problema al generar la respuesta.";
    }

    // Guardar respuesta del asistente
    {
      const { error } = await supabaseServer.from("messages").insert({
        chat_id: chatId,
        role: "assistant",
        content: replyText,
      });

      if (error) {
        console.error("Error guardando mensaje assistant:", error);
        // No rompemos UX por esto
      }
    }

    return ok({ reply: replyText, chatId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";

    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido a correos autorizados."), { status: 403 });
    }
    if (msg === "CHAT_NOT_FOUND") {
      return NextResponse.json(fail("NOT_FOUND", "Chat no encontrado."), { status: 404 });
    }
    if (msg === "FORBIDDEN_CHAT") {
      return NextResponse.json(fail("FORBIDDEN", "No tienes acceso a este chat."), { status: 403 });
    }

    console.error("api/chat error:", e);
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}
