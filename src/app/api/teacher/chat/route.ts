// src/app/api/teacher/chat/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import { getGeminiModel } from "@/lib/geminiClient";

export const runtime = "nodejs";

const BodySchema = z.object({
  message: z.string().trim().min(1, "Mensaje vacío").max(2000),
  context: z
  .object({
    activeStudentId: z.string().uuid().nullable().optional(),
    activeStudentLabel: z.string().nullable().optional(),
    pendingCandidates: z
      .array(
        z.object({
          user_id: z.string().uuid(),
          label: z.string(),
        })
      )
      .optional(),
  })
  .optional(),

});

type TeacherChatContext = {
  activeStudentId: string | null;
  activeStudentLabel: string | null;
  pendingCandidates?: Array<{ user_id: string; label: string }>;
};


type ProfileStudent = {
  user_id: string;
  email: string | null;
  ru: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  registration_status: string | null;
  cohort_id: string | null;
};

function buildStudentLabel(s: ProfileStudent): string {
  const name = [s.first_name, s.last_name].filter(Boolean).join(" ").trim();
  const ru = s.ru ? `RU ${s.ru}` : null;
  const email = s.email ?? null;

  const main = name || email || s.user_id;
  const extra = [ru].filter(Boolean).join(" • ");

  return extra ? `${main} (${extra})` : main;
}

function extractSearchTerm(message: string): string | null {
  const m = message.trim();

  // 1) Frases comunes: "cómo va X", "estado de X", "avance de X", "reporte de X"
  const patterns: RegExp[] = [
    /(?:reporte|resumen|informe)\s*(?:del|de)?\s*(.+)$/i,
    /(?:cambiar|otro|nueva persona|nuevo estudiante)\s*(?:a|al|de)?\s*(.+)$/i,
    /(?:como|cómo)\s+va\s+(.+)$/i,
    /(?:estado|avance|progreso)\s+(?:de|del)\s+(.+)$/i,
    /(?:cómo\s+va|como\s+va)\s*(?:el|la)?\s*(.+)$/i,
  ];

  for (const rx of patterns) {
    const match = m.match(rx);
    if (match?.[1]?.trim()) {
      return cleanupTerm(match[1].trim());
    }
  }

  // 2) Si no matchea, limpiamos la frase completa (pero quitando ruido)
  return cleanupTerm(m.length <= 160 ? m : m.slice(0, 160));
}

function cleanupTerm(term: string): string {
  // Quitar signos y extremos raros
  let t = term
    .replace(/[¿?¡!.,;:"'()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Quitar muletillas comunes al inicio (para que no busque "va alan")
  t = t.replace(
    /^(?:el|la|los|las|un|una|de|del|al|a|por|para|sobre|acerca|dime|mu[eé]strame|quiero|necesito|por favor)\s+/i,
    ""
  );

  return t.trim();
}

function extractRu(search: string): string | null {
  // detecta "RU 12345" o "ru:12345" o "12345"
  const m = search.match(/(?:ru\s*[:#-]?\s*)?(\d{4,12})/i);
  return m?.[1] ?? null;
}

function looksLikeEmail(search: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(search.trim().toLowerCase());
}

async function findStudentsByTerm(term: string): Promise<ProfileStudent[]> {
  const cleaned = term.trim();
  if (!cleaned) return [];

  let query = supabaseServer
    .from("profiles")
    .select(
      "user_id,email,ru,first_name,last_name,company_name,registration_status,cohort_id"
    )
    .eq("role", "student")
    .limit(20);

  // 1) Si parece email: match exacto
  if (looksLikeEmail(cleaned)) {
    const { data, error } = await query.eq("email", cleaned.toLowerCase());
    if (error) return [];
    return (data ?? []) as ProfileStudent[];
  }

  // 2) Si hay RU (número): match exacto por ru
  const ru = extractRu(cleaned);
  if (ru) {
    const { data, error } = await query.eq("ru", ru);
    if (error) return [];
    if (data && data.length > 0) return data as ProfileStudent[];
    // si no encontró por ru exacto, cae a búsqueda general
  }

  // 3) Búsqueda general (ilike)
  const like = `%${cleaned.toLowerCase()}%`;
  const { data, error } = await query.or(
    `ru.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like}`
  );
  if (error) return [];
  return (data ?? []) as ProfileStudent[];
}

async function loadStudentById(userId: string): Promise<ProfileStudent | null> {
  const { data, error } = await supabaseServer
    .from("profiles")
    .select(
      "user_id,email,ru,first_name,last_name,company_name,registration_status,cohort_id"
    )
    .eq("role", "student")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return null;
  return (data ?? null) as ProfileStudent | null;
}

async function getHoursTotal(userId: string): Promise<number> {
  // hours_entries.user_id es uuid; userId viene como string uuid (ok)
  const { data, error } = await supabaseServer
    .from("hours_entries")
    .select("hours")
    .eq("user_id", userId)
    .limit(2000);

  if (error || !data) return 0;
  return data.reduce((acc: number, row: any) => acc + Number(row.hours ?? 0), 0);
}

async function getStagesSummary(userId: string): Promise<{
  validatedStages: number[];
  draftStages: number[];
  lastUpdatedAt: string | null;
}> {
  const { data, error } = await supabaseServer
    .from("plan_stage_artifacts")
    .select("stage,status,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(500);

  if (error || !data) {
    return { validatedStages: [], draftStages: [], lastUpdatedAt: null };
  }

  const validated = new Set<number>();
  const draft = new Set<number>();
  let lastUpdatedAt: string | null = null;

  for (const row of data as any[]) {
    const stage = Number(row.stage);
    if (Number.isFinite(stage)) {
      if (row.status === "validated") validated.add(stage);
      else draft.add(stage);
    }
    if (!lastUpdatedAt && row.updated_at) lastUpdatedAt = String(row.updated_at);
  }

  // Si una etapa está validada, no la listamos como draft
  for (const s of validated) draft.delete(s);

  return {
    validatedStages: Array.from(validated).sort((a, b) => a - b),
    draftStages: Array.from(draft).sort((a, b) => a - b),
    lastUpdatedAt,
  };
}

async function getInteractionsCount(userId: string): Promise<number> {
  // chats.client_id = profiles.user_id (text uuid)
  const { data: chats, error: chatErr } = await supabaseServer
    .from("chats")
    .select("id")
    .eq("client_id", userId)
    .limit(2000);

  if (chatErr || !chats || chats.length === 0) return 0;

  const chatIds = chats.map((c: any) => c.id).filter(Boolean);
  if (chatIds.length === 0) return 0;

  // Contar mensajes (aprox exacto con count)
  const { count, error } = await supabaseServer
    .from("messages")
    .select("id", { count: "exact", head: true })
    .in("chat_id", chatIds);

  if (error) return 0;
  return Number(count ?? 0);
}

function formatReport(student: ProfileStudent, report: {
  hoursTotal: number;
  validatedStages: number[];
  draftStages: number[];
  lastArtifactsUpdate: string | null;
  interactions: number;
}): string {
  const name = [student.first_name, student.last_name].filter(Boolean).join(" ").trim();
  const who = name || student.email || student.user_id;

  const parts: string[] = [];
  parts.push(`📌 REPORTE — ${who}`);
  if (student.ru) parts.push(`🆔 RU: ${student.ru}`);
  if (student.company_name) parts.push(`🏭 Empresa: ${student.company_name}`);

  const v = report.validatedStages;
  const d = report.draftStages;

  parts.push("");
  parts.push("➡️ Progreso");
  parts.push(`• Etapas validadas: ${v.length ? v.join(", ") : "—"}`);
  parts.push(`• Etapas en borrador: ${d.length ? d.join(", ") : "—"}`);

  parts.push("");
  parts.push("➡️ Actividad");
  parts.push(`• Horas acumuladas: ${report.hoursTotal.toFixed(1)}`);
  parts.push(`• Interacciones (mensajes): ${report.interactions}`);

  if (report.lastArtifactsUpdate) {
    const shortDate = report.lastArtifactsUpdate
        ? String(report.lastArtifactsUpdate).slice(0, 10)
        : null;

        if (shortDate) {
        parts.push(`• Última actualización: ${shortDate}`);
    }
  }

  parts.push("");
  parts.push("✅ Puedes pedir:");
  parts.push("• horas");
  parts.push("• etapas");
  parts.push("• interacciones");
  parts.push("• cambiar a <otro estudiante>");

  return parts.join("\n");
}

type Intent =
  | "report"
  | "usage"
  | "progress"
  | "top10"
  | "alerts"
  | "interactions"
  | "hours"
  | "stages"
  | "stage_analysis";

function detectIntent(message: string): Intent {
  const m = message.trim().toLowerCase();

  if (/^(horas?|h)\b/.test(m)) return "hours";
  if (/^(etapas?|stage)\b/.test(m)) return "stages";
  if (/^(interacciones?|mensajes?)\b/.test(m)) return "interactions";

  // ✅ uso del agente (preguntas de cohorte / globales)
  if (
    // Ejemplos: "quién usa más", "quien es la persona que le da más uso", "más uso del chat"
    /(m[aá]s)\s+(uso|actividad|interacciones?|mensajes?)\b/i.test(m) ||
    /(qu[ií]e?n)\s+(es\s+)?(el|la)?\s*(estudiante|persona)?\s*(que\s+)?(m[aá]s)\s+(usa|utiliza|ocup|ha\s+usado)/i.test(m) ||
    // "quién le da más uso", "quién está dando más uso", "quién da más uso"
    /(qu[ií]e?n)\s+(es\s+)?(el|la)?\s*(estudiante|persona)?\s*(que\s+)?(le\s+)?(est[aá]\s+)?d(a|á|an|ando)\s+(m[aá]s)\s+uso/i.test(m) ||
    /(qu[ií]enes|que estudiantes|cu[aá]les)\s+(est[aá]n\s+)?(usando|utilizando|ocupando|dando\s+uso)/i.test(m) ||
    /(uso|actividad)\s+(del\s+)?(agente|chat|asistente)/i.test(m) ||
    /(estudiantes)\s+(activos|inactivos)/i.test(m)
  ) {
    return "usage";
  }

  if (/(top\s*10|mejores\s*10|ranking|top10)/i.test(m)) return "top10";
  if (/(alertas?|atrasad|sin\s+avance|sin\s+actividad|problemas)/i.test(m)) return "alerts";

  const stageN = detectStageNumber(m);
  if (stageN !== null && isStageAnalysisAsk(m)) return "stage_analysis";

  return "report";
}


const TeacherRouterSchema = z.object({
  scope: z.enum(["global", "student"]),
  action: z.enum([
    "report",          // resumen general del estudiante
    "hours",           // horas
    "stages",          // etapas validadas/borrador
    "interactions",    // chats/mensajes
    "usage",           // quiénes usan el agente
    "top10",           // ranking avance
    "alerts",          // alertas
    "stage_analysis",  // análisis académico de una etapa
    "switch_student",  // cambiar estudiante
    "unknown",
  ]),
  term: z.string().trim().min(1).max(160).optional(), // RU/email/nombre
  stage: z.number().int().min(0).max(20).optional(),
  needs_clarification: z.boolean().optional(),
  clarification_question: z.string().trim().min(1).max(240).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

type TeacherRouter = z.infer<typeof TeacherRouterSchema>;



async function routeWithGemini(args: {
  message: string;
  ctx: TeacherChatContext;
}): Promise<TeacherRouter> {
  const model = getGeminiModel();

  const hasActiveStudent = Boolean(args.ctx.activeStudentId);
  const activeStudentLabel = args.ctx.activeStudentLabel ?? null;

  const prompt = `
Eres un asistente para DOCENTES (panel docente OPT-IA).
Tu tarea: clasificar la intención del mensaje y devolver SOLO un JSON válido.

Contexto:
- Hay estudiante en foco: ${hasActiveStudent ? "SI" : "NO"}
- Etiqueta estudiante en foco: ${activeStudentLabel ?? "—"}

Acciones permitidas:
- report: pedir un reporte general del estudiante (progreso+actividad)
- hours: pedir horas acumuladas / último registro
- stages: pedir etapas validadas / borrador
- interactions: pedir número de chats/mensajes
- usage: ver quiénes usan más el agente (ranking por mensajes/chats)
- top10: ranking estudiantes
- alerts: estudiantes con alertas (sin horas, sin etapas, sin registro)
- stage_analysis: análisis académico de una etapa (requiere stage)
- switch_student: cambiar a otro estudiante (requiere term)
- unknown: si no puedes clasificar

Reglas IMPORTANTES:
- Debes incluir "scope":
  - "global" si la pregunta NO depende de un estudiante específico (top10, alerts, usage, métricas generales).
  - "student" si la pregunta es sobre un estudiante en foco o uno que el docente menciona.
- Si el mensaje pide "quién usa más" / "quién le da más uso" / "quién está dando más uso" / "más uso" / "más activo" / "quiénes están usando el agente" =>
  - scope: "global"
  - action: "usage"
  - term: null
- Si el docente menciona un RU, email o nombre, ponlo en "term".
- Si pide "cambiar" o "otro estudiante", usa switch_student y pon term.
- Si pide “analiza etapa X” o “etapa X”, usa stage_analysis y pon stage.
- Si NO hay estudiante en foco y pide report/horas/etapas/interacciones sin mencionar a quién, usa:
  - action: "unknown"
  - needs_clarification: true
  - clarification_question: "¿De qué estudiante? Pásame RU, email o nombre."
- Devuelve SOLO JSON (sin markdown, sin texto extra).

Mensaje del docente:
"${args.message}"
`.trim();

  const res = await model.generateContent(prompt);
  const txt = res.response.text().trim();

  let obj: unknown = null;
  try {
    obj = JSON.parse(txt);
  } catch {
    const start = txt.indexOf("{");
    const end = txt.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(txt.slice(start, end + 1));
      } catch {
        obj = null;
      }
    }
  }

  const parsed = TeacherRouterSchema.safeParse(obj);
  if (!parsed.success) return { scope: "student", action: "unknown", confidence: 0 };
  return parsed.data;
}




function detectStageNumber(message: string): number | null {
  const m = message.toLowerCase();

  // "etapa 2", "etapa: 2", "fase 2"
  const match = m.match(/\b(etapa|fase)\s*[:\-]?\s*(\d{1,2})\b/);
  if (match) return Number(match[2]);

  // "stage 2"
  const match2 = m.match(/\bstage\s*[:\-]?\s*(\d{1,2})\b/);
  if (match2) return Number(match2[1]);

  return null;
}

function isStageAnalysisAsk(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("analiza") ||
    m.includes("analizar") ||
    m.includes("evalua") ||
    m.includes("evalúa") ||
    m.includes("revis") ||
    m.includes("cómo") ||
    m.includes("como") ||
    m.includes("explica") ||
    m.includes("desarroll") ||
    m.includes("detalle") ||
    m.includes("mas detalle") ||
    m.includes("más detalle") ||
    m.includes("que hizo") ||
    m.includes("qué hizo") ||
    m.includes("dame mas") ||
    m.includes("dame más")
  );
}

async function getChatsCount(userId: string): Promise<number> {
  const { count, error } = await supabaseServer
    .from("chats")
    .select("id", { count: "exact", head: true })
    .eq("client_id", userId);

  if (error) return 0;
  return Number(count ?? 0);
}

async function getLastHoursDate(userId: string): Promise<string | null> {
  const { data, error } = await supabaseServer
    .from("hours_entries")
    .select("period_end")
    .eq("user_id", userId)
    .order("period_end", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  const v = (data[0] as any)?.period_end;
  return v ? String(v) : null; // YYYY-MM-DD (date)
}

function formatHoursReply(student: ProfileStudent, hoursTotal: number, lastDate: string | null) {
  const who = [student.first_name, student.last_name].filter(Boolean).join(" ").trim() || student.email || student.user_id;

  const lines: string[] = [];
  lines.push(`⏱️ HORAS — ${who}`);
  if (student.ru) lines.push(`🆔 RU: ${student.ru}`);
  lines.push("");
  lines.push(`• Total acumulado: ${hoursTotal.toFixed(1)}`);
  lines.push(`• Último registro: ${lastDate ?? "—"}`);
  return lines.join("\n");
}

function formatStagesReply(student: ProfileStudent, validated: number[], draft: number[], lastUpdate: string | null) {
  const who = [student.first_name, student.last_name].filter(Boolean).join(" ").trim() || student.email || student.user_id;

  const lines: string[] = [];
  lines.push(`📚 ETAPAS — ${who}`);
  if (student.ru) lines.push(`🆔 RU: ${student.ru}`);
  lines.push("");
  lines.push(`• Validadas: ${validated.length ? validated.join(", ") : "—"}`);
  lines.push(`• En borrador: ${draft.length ? draft.join(", ") : "—"}`);
  if (lastUpdate) lines.push(`• Última actualización: ${String(lastUpdate).slice(0, 10)}`);
  return lines.join("\n");
}

function formatInteractionsReply(student: ProfileStudent, chatsCount: number, messagesCount: number) {
  const who = [student.first_name, student.last_name].filter(Boolean).join(" ").trim() || student.email || student.user_id;

  const lines: string[] = [];
  lines.push(`💬 INTERACCIONES — ${who}`);
  if (student.ru) lines.push(`🆔 RU: ${student.ru}`);
  lines.push("");
  lines.push(`• Chats: ${chatsCount}`);
  lines.push(`• Mensajes (total): ${messagesCount}`);
  return lines.join("\n");
}

async function getUsageSummary(message: string): Promise<string> {
  const { data: students, error: stErr } = await supabaseServer
    .from("profiles")
    .select("user_id,ru,first_name,last_name")
    .eq("role", "student")
    .eq("registration_status", "approved")
    .limit(200);

  if (stErr || !students || students.length === 0) {
    return "No hay estudiantes aprobados para analizar uso del agente.";
  }

  const ids = students.map((s: any) => s.user_id).filter(Boolean);

  const { data: chats } = await supabaseServer
    .from("chats")
    .select("id,client_id")
    .in("client_id", ids)
    .limit(5000);

  if (!chats || chats.length === 0) {
    return "Aún no hay actividad registrada en el chat.";
  }

  const chatIds = chats.map((c: any) => c.id);

  const { data: messages } = await supabaseServer
    .from("messages")
    .select("chat_id")
    .in("chat_id", chatIds)
    .limit(20000);

  const messagesByChat = new Map<string, number>();
  if (messages) {
    for (const m of messages as any[]) {
      const cid = String(m.chat_id);
      messagesByChat.set(cid, (messagesByChat.get(cid) ?? 0) + 1);
    }
  }

  const usageByStudent = new Map<string, { chats: number; messages: number }>();
  for (const c of chats as any[]) {
    const uid = String(c.client_id);
    if (!usageByStudent.has(uid)) usageByStudent.set(uid, { chats: 0, messages: 0 });

    const record = usageByStudent.get(uid)!;
    record.chats += 1;
    record.messages += messagesByChat.get(String(c.id)) ?? 0;
  }

  const ranked = (students as any[])
    .map((s) => {
      const u = usageByStudent.get(String(s.user_id));
      return {
        name: [s.first_name, s.last_name].filter(Boolean).join(" ").trim() || "Estudiante",
        ru: s.ru ? `RU ${s.ru}` : "RU —",
        chats: u?.chats ?? 0,
        messages: u?.messages ?? 0,
      };
    })
    .filter((r) => r.chats > 0 || r.messages > 0)
    .sort((a, b) => b.messages - a.messages);

  if (ranked.length === 0) {
    return "Aún no encontré estudiantes con actividad en el agente.";
  }

  // ✅ Interpretación simple de la pregunta del docente
  const q = message.toLowerCase();
  const wantsSingle =
    /(qui[eé]n|cual|cu[aá]l)\s+(es|ser[ií]a)?\s*(la\s*)?(persona|estudiante)?\s*(que)?\s*(m[aá]s|mayor)/i.test(q) ||
    /m[aá]s\s+uso|m[aá]s\s+utiliza|m[aá]s\s+activo/i.test(q);

  const top = ranked[0];
  const top5 = ranked.slice(0, 5);

  // ✅ IA (Gemini) para responder “como asesor real”
  try {
    const model = getGeminiModel();

    const prompt = `
Eres un asesor docente (tono humano, claro y directo) dentro de una app académica.
Tu tarea: responder la consulta del docente usando SOLO los datos provistos.
- No inventes estudiantes ni cifras.
- Explica el criterio usado (por mensajes y/o por chats).
- Si el docente pregunta "quién es el que más usa", responde con el #1 y luego muestra top 3 o top 5.
- Si el docente pide "quiénes usan / ranking", muestra un ranking corto.
- Cierra con 1 sugerencia útil (ej: a quién hacer seguimiento, o qué indicador mirar después).
Responde en español.

Pregunta del docente: "${message}"

Datos (ranking por mensajes):
${JSON.stringify(
  {
    totalActivos: ranked.length,
    top: top,
    top5: top5,
  },
  null,
  2
)}
`.trim();

    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.()?.trim();
    if (text) return text;
  } catch {
    // fallback abajo
  }

  // ✅ Fallback sin IA (por si Gemini falla)
  if (wantsSingle) {
    return [
      `📌 El estudiante con **más uso** es: **${top.name} (${top.ru})**.`,
      `• Mensajes: **${top.messages}**`,
      `• Chats: **${top.chats}**`,
      ``,
      `Top 5 por uso (mensajes):`,
      ...top5.map((r, i) => `${i + 1}) ${r.name} (${r.ru}) — 💬 ${r.messages} • 🗂️ ${r.chats}`),
    ].join("\n");
  }

  return [
    `📊 Ranking de uso del agente (por mensajes). Activos: ${ranked.length}`,
    ``,
    ...top5.map((r, i) => `${i + 1}) ${r.name} (${r.ru}) — 💬 ${r.messages} • 🗂️ ${r.chats}`),
    ``,
    `Si quieres, puedo mostrar "los menos activos" o "alertas por falta de avance".`,
  ].join("\n");
}

async function getTop10(): Promise<string> {
  // 1) estudiantes aprobados (máx 200 para MVP)
  const { data: students, error: stErr } = await supabaseServer
    .from("profiles")
    .select("user_id,ru,first_name,last_name,company_name")
    .eq("role", "student")
    .eq("registration_status", "approved")
    .limit(200);

  if (stErr || !students || students.length === 0) {
    return "No hay estudiantes aprobados para calcular el Top 10.";
  }

  const ids = students.map((s: any) => s.user_id).filter(Boolean);

  // 2) stages validadas (para esos estudiantes)
  const { data: arts, error: aErr } = await supabaseServer
    .from("plan_stage_artifacts")
    .select("user_id,stage,status")
    .in("user_id", ids)
    .eq("status", "validated")
    .limit(5000);

  const validatedCountByUser = new Map<string, Set<number>>();
  if (!aErr && arts) {
    for (const r of arts as any[]) {
      const uid = String(r.user_id);
      const stage = Number(r.stage);
      if (!Number.isFinite(stage)) continue;
      if (!validatedCountByUser.has(uid)) validatedCountByUser.set(uid, new Set<number>());
      validatedCountByUser.get(uid)!.add(stage);
    }
  }

  // 3) horas (para esos estudiantes)
  const { data: hrs, error: hErr } = await supabaseServer
    .from("hours_entries")
    .select("user_id,hours")
    .in("user_id", ids)
    .limit(5000);

  const hoursByUser = new Map<string, number>();
  if (!hErr && hrs) {
    for (const r of hrs as any[]) {
      const uid = String(r.user_id);
      const val = Number(r.hours ?? 0);
      hoursByUser.set(uid, (hoursByUser.get(uid) ?? 0) + (Number.isFinite(val) ? val : 0));
    }
  }

  // rank: etapas validadas desc, luego horas desc
  const ranked = (students as any[])
    .map((s) => {
      const uid = String(s.user_id);
      const stages = validatedCountByUser.get(uid)?.size ?? 0;
      const hours = hoursByUser.get(uid) ?? 0;
      return { ...s, stages, hours };
    })
    .sort((a, b) => (b.stages - a.stages) || (b.hours - a.hours))
    .slice(0, 10);

  const lines: string[] = [];
  lines.push("🏆 TOP 10 — Avance (etapas validadas) + horas");
  lines.push("");

  ranked.forEach((s, i) => {
    const name = [s.first_name, s.last_name].filter(Boolean).join(" ").trim() || s.user_id;
    const ru = s.ru ? `RU ${s.ru}` : "RU —";
    lines.push(`${i + 1}) ${name} (${ru}) — ✅ ${s.stages} etapas — ⏱️ ${Number(s.hours).toFixed(1)} h`);
  });

  lines.push("");
  lines.push("Tip: pide `reporte de <RU>` para ver detalle de uno.");
  return lines.join("\n");
}

async function getAlerts(): Promise<string> {
  // Alertas simples (MVP) sobre estudiantes aprobados
  const { data: students, error: stErr } = await supabaseServer
    .from("profiles")
    .select("user_id,ru,first_name,last_name")
    .eq("role", "student")
    .eq("registration_status", "approved")
    .limit(200);

  if (stErr || !students || students.length === 0) {
    return "No hay estudiantes aprobados para analizar alertas.";
  }

  const ids = students.map((s: any) => s.user_id).filter(Boolean);

  // Horas totales por estudiante
  const { data: hrs, error: hErr } = await supabaseServer
    .from("hours_entries")
    .select("user_id,hours,period_end")
    .in("user_id", ids)
    .limit(5000);

  const hoursByUser = new Map<string, number>();
  const lastHoursDateByUser = new Map<string, string>();

  if (!hErr && hrs) {
    for (const r of hrs as any[]) {
      const uid = String(r.user_id);
      const val = Number(r.hours ?? 0);
      hoursByUser.set(uid, (hoursByUser.get(uid) ?? 0) + (Number.isFinite(val) ? val : 0));

      const d = r.period_end ? String(r.period_end) : null;
      if (d) {
        const prev = lastHoursDateByUser.get(uid);
        if (!prev || d > prev) lastHoursDateByUser.set(uid, d);
      }
    }
  }

  // Etapas validadas por estudiante
  const { data: arts, error: aErr } = await supabaseServer
    .from("plan_stage_artifacts")
    .select("user_id,stage,status")
    .in("user_id", ids)
    .eq("status", "validated")
    .limit(5000);

  const validatedStagesByUser = new Map<string, Set<number>>();
  if (!aErr && arts) {
    for (const r of arts as any[]) {
      const uid = String(r.user_id);
      const stage = Number(r.stage);
      if (!Number.isFinite(stage)) continue;
      if (!validatedStagesByUser.has(uid)) validatedStagesByUser.set(uid, new Set<number>());
      validatedStagesByUser.get(uid)!.add(stage);
    }
  }

  // Construir alertas simples
  const rows: string[] = [];
  for (const s of students as any[]) {
    const uid = String(s.user_id);
    const name = [s.first_name, s.last_name].filter(Boolean).join(" ").trim() || uid;
    const ru = s.ru ? `RU ${s.ru}` : "RU —";

    const total = hoursByUser.get(uid) ?? 0;
    const last = lastHoursDateByUser.get(uid) ?? null;
    const stages = validatedStagesByUser.get(uid)?.size ?? 0;

    // Reglas MVP:
    const flags: string[] = [];
    if (total === 0) flags.push("sin horas");
    if (stages === 0) flags.push("sin etapas validadas");
    if (!last) flags.push("sin registro reciente");

    if (flags.length) {
      rows.push(`• ${name} (${ru}) — ⚠️ ${flags.join(" / ")}`);
    }
  }

  if (rows.length === 0) {
    return "✅ No encontré alertas básicas (horas/etapas) en estudiantes aprobados.";
  }

  return ["🚨 ALERTAS — Estudiantes aprobados", "", ...rows.slice(0, 20), "", "Tip: pide `reporte de <RU>`."].join("\n");
}

async function getLatestStageArtifact(userId: string, stage: number) {
  const { data, error } = await supabaseServer
    .from("plan_stage_artifacts")
    .select("id,stage,status,artifact_type,payload,score,updated_at,created_at")
    .eq("user_id", userId)
    .eq("stage", stage)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0] as any;
}

async function getLatestStageEvaluation(userId: string, stage: number) {
  const { data, error } = await supabaseServer
    .from("plan_stage_evaluations")
    .select("id,stage,total_score,total_label,rubric_json,result_json,created_at")
    .eq("user_id", userId)
    .eq("stage", stage)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0] as any;
}

async function analyzeStageWithGemini(args: {
  studentLabel: string;
  stage: number;
  artifact: any | null;
  evaluation: any | null;
  question: string;
}) {
  const model = getGeminiModel();

  const artifactPayload = args.artifact?.payload ?? null;
  const artifactStatus = args.artifact?.status ?? null;
  const updatedAt = args.artifact?.updated_at ?? null;

  const evalSummary = args.evaluation
    ? {
        total_score: args.evaluation.total_score,
        total_label: args.evaluation.total_label,
        result_json: args.evaluation.result_json,
      }
    : null;

  const prompt = `
Eres un asistente para DOCENTES de Ingeniería de Métodos.
Tu tarea: analizar la ETAPA ${args.stage} del estudiante (sin inventar).

Estudiante: ${args.studentLabel}
Pregunta del docente: "${args.question}"

Datos reales disponibles:
- artifact_status: ${String(artifactStatus)}
- artifact_updated_at: ${updatedAt ? String(updatedAt).slice(0, 10) : "—"}
- artifact_payload (JSON): ${artifactPayload ? JSON.stringify(artifactPayload).slice(0, 8000) : "null"}
- evaluation_summary: ${evalSummary ? JSON.stringify(evalSummary).slice(0, 8000) : "null"}

Reglas:
- NO inventes información fuera de estos datos.
- Si faltan datos, dilo claro (“no hay artifact cargado en etapa X”).
- Responde con secciones:

1) Estado (validado/borrador y fecha)
2) Qué hizo bien (máx 4 bullets)
3) Qué falta / observaciones (máx 6 bullets)
4) Recomendación concreta (3 pasos)
5) Pregunta sugerida al estudiante (1 línea)

Escribe en español y tono profesional.
`.trim();

  const res = await model.generateContent(prompt);
  return res.response.text();
}

function formatStudentRefForTeacher(args: {
  student: ProfileStudent;
  canSeePII: boolean;
}): string {
  if (!args.canSeePII) {
    if (args.student.ru) return `Estudiante (RU ${args.student.ru})`;
    const short = args.student.user_id ? String(args.student.user_id).slice(0, 8) : "—";
    return `Estudiante (${short})`;
  }

  // Docente autorizado: mostrar identificadores reales
  const name =
  ("name" in args.student && typeof (args.student as any).name === "string" && (args.student as any).name.trim()) ||
  ("display_name" in args.student &&
    typeof (args.student as any).display_name === "string" &&
    (args.student as any).display_name.trim()) ||
  ("fullName" in args.student &&
    typeof (args.student as any).fullName === "string" &&
    (args.student as any).fullName.trim()) ||
  "Sin nombre";
  const ru = args.student.ru ? ` • RU ${args.student.ru}` : "";
  const companyName =
    ("company_name" in args.student &&
      typeof (args.student as any).company_name === "string" &&
      (args.student as any).company_name.trim()) ||
    ("company" in args.student &&
      typeof (args.student as any).company === "string" &&
      (args.student as any).company.trim()) ||
    ("companyName" in args.student &&
      typeof (args.student as any).companyName === "string" &&
      (args.student as any).companyName.trim()) ||
    "";

  const company = companyName ? ` • Empresa: ${companyName}` : "";

  return `${name}${ru}${company}`;
}

async function getRecentArtifactsSummary(userId: string): Promise<
  Array<{ stage: number; status: string | null; score: number | null; updated_at: string | null }>
> {
  const { data, error } = await supabaseServer
    .from("plan_stage_artifacts")
    .select("stage,status,score,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(10);

  if (error || !data) return [];
  return (data as any[]).map((r) => ({
    stage: Number(r.stage),
    status: r.status ?? null,
    score: r.score !== undefined && r.score !== null ? Number(r.score) : null,
    updated_at: r.updated_at ? String(r.updated_at) : null,
  }));
}

async function getRecentEvaluationsSummary(userId: string): Promise<
  Array<{ stage: number; total_score: number | null; total_label: string | null; created_at: string | null }>
> {
  const { data, error } = await supabaseServer
    .from("plan_stage_evaluations")
    .select("stage,total_score,total_label,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error || !data) return [];
  return (data as any[]).map((r) => ({
    stage: Number(r.stage),
    total_score: r.total_score !== undefined && r.total_score !== null ? Number(r.total_score) : null,
    total_label: r.total_label ?? null,
    created_at: r.created_at ? String(r.created_at) : null,
  }));
}

async function answerTeacherWithGemini(args: {
  question: string;
  intent: Intent;
  student: ProfileStudent;
  ctx: TeacherChatContext;
  snapshot: {
    hoursTotal: number;
    lastHoursDate: string | null;
    stages: {
      validatedStages: number[];
      draftStages: number[];
      lastUpdatedAt: string | null;
    };
    chatsCount: number;
    messagesCount: number;
    recentArtifacts: Array<{ stage: number; status: string | null; score: number | null; updated_at: string | null }>;
    recentEvaluations: Array<{ stage: number; total_score: number | null; total_label: string | null; created_at: string | null }>;
  };
}): Promise<string> {
  const model = getGeminiModel();

  const studentRef = formatStudentRefForTeacher({
    student: args.student,
    canSeePII: true, // porque este endpoint es SOLO docente
  });

  const prompt = `
Eres un asistente con IA para DOCENTES de Ingeniería de Métodos (OPT-IA).
Tu trabajo: responder al docente con base en DATOS REALES del estudiante (sin inventar).

PRIVACIDAD:
- Este endpoint es para DOCENTES autorizados.
- Puedes incluir nombre, RU y empresa si están disponibles.
- No incluyas datos innecesarios (p.ej. email completo) a menos que el docente lo pida explícitamente.
- Nunca reveles información de otros estudiantes que no estén consultados.

Mensaje del docente:
"${args.question}"

Intención detectada: ${args.intent}

Contexto actual del chat:
- activeStudentId: ${args.ctx.activeStudentId ?? "null"}
- activeStudentLabel: ${args.ctx.activeStudentLabel ?? "null"}

DATOS REALES (snapshot):
- Horas acumuladas: ${args.snapshot.hoursTotal.toFixed(1)}
- Último registro de horas: ${args.snapshot.lastHoursDate ?? "—"}
- Etapas validadas: ${args.snapshot.stages.validatedStages.length ? args.snapshot.stages.validatedStages.join(", ") : "—"}
- Etapas en borrador: ${args.snapshot.stages.draftStages.length ? args.snapshot.stages.draftStages.join(", ") : "—"}
- Última actualización de entregables: ${args.snapshot.stages.lastUpdatedAt ? String(args.snapshot.stages.lastUpdatedAt).slice(0, 10) : "—"}
- Chats: ${args.snapshot.chatsCount}
- Mensajes: ${args.snapshot.messagesCount}

- Últimos artifacts (máx 10): ${JSON.stringify(args.snapshot.recentArtifacts).slice(0, 4000)}
- Últimas evaluaciones (máx 10): ${JSON.stringify(args.snapshot.recentEvaluations).slice(0, 4000)}

REGLAS:
- Si falta información para responder, dilo claro y propone qué pedirle al estudiante.
- Responde breve, claro y accionable. No “modo bot”.
- Evita listar comandos. Evita textos tipo “Puedes pedir...”.

FORMATO DE RESPUESTA (usa estos títulos):
1) Resumen rápido (2–3 líneas)
2) Estado actual (bullets)
3) Alertas / riesgos (si aplica)
4) Recomendación al docente (3 acciones concretas)
5) Pregunta sugerida al estudiante (1 línea)

Escribe en español, tono profesional y humano.
`.trim();

  const res = await model.generateContent(prompt);
  return res.response.text().trim();
}


export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return NextResponse.json(fail("FORBIDDEN", "Solo docentes."), { status: 403 });
    }

    const json = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", "Payload inválido.", parsed.error.flatten()),
        { status: 400 }
      );
    }

    const message = parsed.data.message.trim();
    const incomingActiveId = parsed.data.context?.activeStudentId ?? null;

    let ctx: TeacherChatContext = {
        activeStudentId: incomingActiveId,
        activeStudentLabel: parsed.data.context?.activeStudentLabel ?? null,
        pendingCandidates: parsed.data.context?.pendingCandidates ?? undefined,
    };

    let activeStudent: ProfileStudent | null = null;

    const pick = message.trim().toLowerCase();

    // ✅ Soporta: "1", "de 1", "opcion 1", "opción 1", "el 1"
    const pickMatch =
    pick.match(/^\s*(\d{1,2})\s*$/) ||
    pick.match(/^\s*(?:de|el|la|opcion|opción|n(?:u|ú)mero|num|#)\s*(\d{1,2})\s*$/);

    const pickNum = pickMatch ? Number(pickMatch[1] ?? pickMatch[2]) : null;

    if (!ctx.activeStudentId && pickNum && ctx.pendingCandidates?.length) {
    if (pickNum >= 1 && pickNum <= ctx.pendingCandidates.length) {
        const chosen = ctx.pendingCandidates[pickNum - 1];
        const s = await loadStudentById(chosen.user_id);
        if (s) {
        ctx = {
            activeStudentId: s.user_id,
            activeStudentLabel: buildStudentLabel(s),
            pendingCandidates: undefined,
        };
        activeStudent = s; // 👈 importante: ya tenemos estudiante en foco
        }
    }
    }

    if (!activeStudent && ctx.activeStudentId) {
        activeStudent = await loadStudentById(ctx.activeStudentId);
        if (activeStudent) ctx.activeStudentLabel = buildStudentLabel(activeStudent);
        else ctx.activeStudentId = null;
    }

    // 1) Intent rápido por regex (para comandos cortos)
    let intent = detectIntent(message);

    // 2) Router con Gemini (para que el chat docente "entienda" preguntas naturales)
    //    Solo evitamos LLM en comandos MUY cortos y obvios para mantenerlo rápido.
    const trimmed = message.trim();
    const isExplicitShortCommand =
      trimmed.length <= 40 &&
      /^(top\s*10|top10|ranking|alertas?|uso|actividad|interacciones?|mensajes?|chats?|horas?|etapas?)\b/i.test(trimmed);

    // Por defecto, el chat docente debería comportarse como "IA" -> intentamos rutear con LLM.
    if (!isExplicitShortCommand) {
      const routed = await routeWithGemini({
        message,
        ctx,
      });

      // mapeo de acción LLM a intent existente
      if (routed.action === "switch_student") {
        (ctx as any).__llm_switch_term = routed.term ?? null;
        intent = "report";
      } else if (routed.action === "stage_analysis") {
        (ctx as any).__llm_stage = routed.stage ?? null;
        intent = "stage_analysis";
      } else if (routed.action === "hours") intent = "hours";
      else if (routed.action === "stages") intent = "stages";
      else if (routed.action === "interactions") intent = "interactions";
      else if (routed.action === "usage") intent = "usage";
      else if (routed.action === "top10") intent = "top10";
      else if (routed.action === "alerts") intent = "alerts";
      else if (routed.action === "report") intent = "report";
    }

    // ✅ GLOBAL: top10/alertas sin estudiante en foco
    if (intent === "top10") {
    const reply = await getTop10();
    return ok({ reply, context: ctx });
    }

    if (intent === "alerts") {
    const reply = await getAlerts();
    return ok({ reply, context: ctx });
    }

    if (intent === "usage") {
      const reply = await getUsageSummary(message);
      return ok({ reply, context: ctx });
    }

    const llmTerm = (ctx as any).__llm_term as string | null | undefined;
    const llmWantsChange = (ctx as any).__llm_wantsChange as boolean | undefined;

    const term = llmTerm ? llmTerm : extractSearchTerm(message);

    const wantsChange =
      Boolean(llmWantsChange) ||
      /(?:cambiar|otro|nueva persona|nuevo estudiante)/i.test(message);

    // 2) Si no hay estudiante activo o el docente quiere cambiar → resolver estudiante
    if (!activeStudent || wantsChange) {
      const students = term ? await findStudentsByTerm(term) : [];

      if (students.length === 0) {
        const hint = term ? `Intenté buscar: "${term}". ` : "";
        const reply = [
          `${hint}No pude identificar al estudiante todavía.`,
          "",
          "Prueba con uno de estos formatos:",
          "- RU (ej: `RU 12345` o `12345`)",
          "- Email institucional",
          "- Nombre + apellido (ej: `Alan Lima`)",
          "",
          "Si quieres, también puedes decirme: **“cambiar a RU 12345”** o **“buscar Alan Lima”**.",
        ].join("\n");

        return ok({ reply, context: ctx });
      }

      if (students.length > 1) {
        const list = students.slice(0, 8).map((s) => ({
            user_id: s.user_id,
            label: buildStudentLabel(s),
        }));

        const lines = list.map((s, i) => `${i + 1}) ${s.label}`).join("\n");

        return ok({
            reply:
            "Encontré varias coincidencias. Responde con el número (1,2,3...) o con el RU/email exacto:\n\n" +
            lines,
            context: { activeStudentId: null, activeStudentLabel: null, pendingCandidates: list },
        });
      }

      activeStudent = students[0];
      ctx = {
        activeStudentId: activeStudent.user_id,
        activeStudentLabel: buildStudentLabel(activeStudent),
      };
    }

    // Si hay estudiante en foco, y piden comando corto:
    if (activeStudent) {
    if (intent === "hours") {
        const total = await getHoursTotal(activeStudent.user_id);
        const last = await getLastHoursDate(activeStudent.user_id);
        const reply = formatHoursReply(activeStudent, total, last);
        return ok({ reply, context: ctx });
    }

    if (intent === "stages") {
        const s = await getStagesSummary(activeStudent.user_id);
        const reply = formatStagesReply(activeStudent, s.validatedStages, s.draftStages, s.lastUpdatedAt);
        return ok({ reply, context: ctx });
    }

    if (intent === "interactions") {
        const chatsCount = await getChatsCount(activeStudent.user_id);
        const messagesCount = await getInteractionsCount(activeStudent.user_id);
        const reply = formatInteractionsReply(activeStudent, chatsCount, messagesCount);
        return ok({ reply, context: ctx });
    }
    }

    // ✅ Análisis académico de etapa (requiere estudiante en foco)
    if (activeStudent && intent === "stage_analysis") {
    const llmStage = (ctx as any).__llm_stage as number | null | undefined;
    const stageN = llmStage ?? detectStageNumber(message);

    if (!stageN) {
        return ok({
        reply: "¿Qué etapa quieres analizar? Ej: “analiza la etapa 2”.",
        context: ctx,
        });
    }

    const artifact = await getLatestStageArtifact(activeStudent.user_id, stageN);
    const evaluation = await getLatestStageEvaluation(activeStudent.user_id, stageN);

    const studentLabel = buildStudentLabel(activeStudent);

    // Si no hay nada cargado en esa etapa, responder sin inventar
    if (!artifact && !evaluation) {
        return ok({
        reply: `No encuentro entregables registrados para la etapa ${stageN} en este estudiante. Pídele que la complete o que suba su avance.`,
        context: ctx,
        });
    }

    const reply = await analyzeStageWithGemini({
        studentLabel,
        stage: stageN,
        artifact,
        evaluation,
        question: message,
    });

    return ok({ reply, context: ctx });
    }

    // ✅ Respuesta IA (asistente real) usando datos reales + redacción Gemini
    const hoursTotal = await getHoursTotal(activeStudent!.user_id);
    const lastHoursDate = await getLastHoursDate(activeStudent!.user_id);

    const stages = await getStagesSummary(activeStudent!.user_id);

    const chatsCount = await getChatsCount(activeStudent!.user_id);
    const messagesCount = await getInteractionsCount(activeStudent!.user_id);

    const recentArtifacts = await getRecentArtifactsSummary(activeStudent!.user_id);
    const recentEvaluations = await getRecentEvaluationsSummary(activeStudent!.user_id);

    const reply = await answerTeacherWithGemini({
      question: message,
      intent,
      student: activeStudent!,
      ctx,
      snapshot: {
        hoursTotal,
        lastHoursDate,
        stages,
        chatsCount,
        messagesCount,
        recentArtifacts,
        recentEvaluations,
      },
    });

    return ok({ reply, context: ctx });

  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido."), { status: 403 });
    }
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}
