//src/app/api/plans/ishikawa/assistant/route.ts

import { ok, failResponse } from "@/lib/api/response";
import { getGeminiModel } from "@/lib/geminiClient";
import { requireUser } from "@/lib/auth/supabase";

type IshikawaWhy = string | { id?: string; text?: string };

type IshikawaCategory = {
  id: string;
  name: string;
  mainCauses: Array<{
    id: string;
    text?: string;
    name?: string;
    subCauses: Array<{
      id: string;
      text?: string;
      name?: string;
      whys?: IshikawaWhy[];
    }>;
  }>;
};

export type IshikawaState = {
  problem: { text: string } | string | null;
  categories: IshikawaCategory[];
  minCategories: number; // 4-5
  minMainCausesPerCategory: number; // 2-3
  minSubCausesPerMain: number; // 2-3
  maxWhyDepth: number; // 3-5 (prefer 3)
  cursor?: { categoryId?: string; mainCauseId?: string; subCauseId?: string } | null;
  rootCauses?: string[]; // opcional: se puede rellenar al final
};

function extractJsonSafe(raw: string) {
  if (!raw) return null;

  // 1) limpia fences tipo ```json ... ```
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // 2) intento directo
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 3) fallback: extraer el primer bloque { ... } del texto
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  return null;
}

async function llmText(prompt: string) {
  const model = getGeminiModel();
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function geminiText(args: { system: string; prompt: string; temperature?: number }) {
  const model = getGeminiModel();
  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: `${args.system}\n\n${args.prompt}` }],
      },
    ],
    generationConfig: { temperature: args.temperature ?? 0.2 },
  });
  return result.response.text();
}

function isAdvanceToStage4Message(text: string) {
  const t = (text ?? "").toLowerCase().trim();
  if (!t) return false;

  // frases típicas que escriben cuando aceptan pasar de etapa
  const patterns = [
    "pasemos",
    "pasar a la etapa",
    "etapa 4",
    "ishikawa",
    "si",
    "sí",
    "ok",
    "okay",
    "dale",
    "arranquemos",
    "vamos",
    "continuemos",
    "siguiente",
    "listo",
  ];

  // si el mensaje es corto o claramente confirmación
  if (t.length <= 12 && patterns.includes(t)) return true;

  // o si contiene frase de avanzar
  return patterns.some((p) => t.includes(p)) && (t.includes("etapa") || t.includes("ishikawa") || t.includes("pas"));
}

function ensureDefaultCategoriesIfEmpty(state: IshikawaState): IshikawaState {
  if (state.categories?.length) return state;

  const mkCat = (id: string, name: string) => ({ id, name, mainCauses: [] });

  return {
    ...state,
    categories: [
      mkCat("cat_hombre", "Hombre"),
      mkCat("cat_maquina", "Máquina"),
      mkCat("cat_metodo", "Método"),
      mkCat("cat_material", "Material"),
      mkCat("cat_medida", "Medida"),
      mkCat("cat_entorno", "Entorno"),
    ],
  };
}

function hasAnyMainCause(state: IshikawaState) {
  return Array.isArray(state.categories) && state.categories.some((c) => Array.isArray(c.mainCauses) && c.mainCauses.length > 0);
}

function guessCategoryIdFromText(state: IshikawaState, text: string): string | null {
  const t = (text ?? "").toLowerCase();

  const matchByName = (includes: string[]) =>
    state.categories?.find(c => includes.some(k => (c.name ?? "").toLowerCase().includes(k)))?.id ?? null;

  // Entorno
  if (/(ilumin|luz|ruido|temper|calor|fr[ií]o|polvo|humedad|ventil|vibraci)/.test(t)) {
    return matchByName(["entorno", "medio ambiente", "ambiente"]);
  }

  // Método
  if (/(proced|est[aá]ndar|sop|m[eé]todo|instruct|checklist|cambio de formato|set.?up|setup|sm(e|é)d)/.test(t)) {
    return matchByName(["método", "metodo"]);
  }

  // Hombre
  if (/(operari|capacit|supervisi|disciplina|turno|fatiga|motiv|error humano)/.test(t)) {
    return matchByName(["hombre", "mano de obra"]);
  }

  // Máquina
  if (/(m[aá]quina|equipo|sensor|falla|calibr|desgaste|gu[ií]a|motor|rodillo|boquilla)/.test(t)) {
    return matchByName(["máquina", "maquina"]);
  }

  // Material
  if (/(insumo|envase|botella|materia prima|tapa|etiqueta|calidad de material)/.test(t)) {
    return matchByName(["material"]);
  }

  // Medición
  if (/(medici|indicador|oee|registro|control|inspecci|dato|kpi)/.test(t)) {
    return matchByName(["medici", "medición", "medicion"]);
  }

  return null;
}

function buildIshikawaMap(state: IshikawaState) {
  const problem =
    typeof state.problem === "string" ? state.problem :
    state.problem?.text ?? "";

  const lines: string[] = [];
  lines.push(`🧠 Problema: ${problem || "(sin problema)"}`);
  lines.push("");

  // Conteos por categoría
  for (const c of state.categories ?? []) {
    const count = c.mainCauses?.length ?? 0;
    lines.push(`- ${c.name}: ${count}/${state.minMainCausesPerCategory} causas principales`);
  }

    lines.push("");
    lines.push("🧩 Mapa (con niveles):");

    const IND0 = "";
    const IND1 = "  ├─ ";
    const IND2 = "  │   ├─ ";
    const IND3 = "  │   │   ├─ ";

    for (const c of state.categories ?? []) {
    // solo mostrar categoría si tiene algo (o muéstralas todas si quieres)
    const has = (c.mainCauses?.length ?? 0) > 0;

    lines.push(`${IND0}• ${c.name}`);

    for (const mc of c.mainCauses ?? []) {
        const mcName = mc.name ?? mc.text ?? "(sin nombre)";
        lines.push(`${IND1}${mcName}`);

        for (const sc of mc.subCauses ?? []) {
        const scName = sc.name ?? sc.text ?? "(sin nombre)";
        lines.push(`${IND2}${scName}`);

        const whys = (sc.whys ?? [])
            .map(w => typeof w === "string" ? w : (w.text ?? ""))
            .filter(Boolean);

        for (let i = 0; i < whys.length; i++) {
            lines.push(`${IND3}${i + 1}) ${whys[i]}`);
        }
        }
    }
    }


  // Rama activa
  if (state.cursor?.categoryId && state.cursor?.mainCauseId) {
    const cat = state.categories.find(c => c.id === state.cursor?.categoryId);
    const mc = cat?.mainCauses.find(m => m.id === state.cursor?.mainCauseId);
    const catName = cat?.name ?? "(categoría)";
    const mcName = (mc?.name ?? mc?.text) ?? "(causa)";
    lines.push("");
    lines.push(`📍 Rama activa: ${catName} → ${mcName}`);
  }

  return lines.join("\n");
}


export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);
    const userId = authed.userId;

    const body = await req.json().catch(() => null);
    const studentMessage = (body?.studentMessage ?? "").toString();
    const ishikawaState = body?.ishikawaState as IshikawaState | null;
    const caseContext = body?.caseContext ?? null;
    const stage1Summary = body?.stage1Summary ?? null;
    const brainstormState = body?.brainstormState ?? null;

    if (!studentMessage.trim()) {
    return failResponse("BAD_REQUEST", "Mensaje vacío", 400);
    }
    if (!ishikawaState) {
    return failResponse("BAD_REQUEST", "Falta ishikawaState", 400);
    }

    const msgLower = studentMessage.trim().toLowerCase();

    const wantsMap =
    msgLower.includes("situacion actual") ||
    msgLower.includes("situación actual") ||
    msgLower.includes("mapa") ||
    msgLower.includes("estado actual") ||
    msgLower.includes("resumen") ||
    msgLower.includes("que tenemos") ||
    msgLower.includes("qué tenemos") ||
    msgLower.includes("en que rama") ||
    msgLower.includes("en qué rama");

    if (wantsMap) {
    const nextState = ensureDefaultCategoriesIfEmpty(ishikawaState);
    return ok({
        assistantMessage: buildIshikawaMap(nextState),
        updates: { nextState },
    });
    }

    // 0) Si el estudiante está confirmando avanzar a Etapa 4, damos introducción y arrancamos
    if (isAdvanceToStage4Message(studentMessage) && !hasAnyMainCause(ishikawaState)) {
      const nextState = ensureDefaultCategoriesIfEmpty(ishikawaState);

      const problemText =
        typeof ishikawaState.problem === "string"
            ? ishikawaState.problem
            : ishikawaState.problem?.text ?? "";

        return ok({
        assistantMessage:
            "✅ **Listo, pasamos a la Etapa 4: Ishikawa + 5 Porqués.**\n\n" +
            "**¿Qué haremos?** Ordenaremos causas por categorías (6M) y profundizaremos con “¿por qué?” hasta llegar a una causa raíz.\n\n" +
            (problemText
            ? `🎯 **Problema (cabeza):** ${problemText}\n\n`
            : "") +
            "📌 **Primer paso (primer porqué desde el problema):**\n" +
            (problemText
            ? `¿**Por qué ocurre** este problema? (responde con una causa concreta: qué pasa / dónde / cuándo)\n\n`
            : "¿Por qué ocurre el problema principal? (qué pasa / dónde / cuándo)\n\n") +
            "Ejemplo: “La línea baja la velocidad porque el etiquetado genera atascos en el turno tarde”.",
        updates: { nextState },
        });

    }

    // ...después de validar studentMessage e ishikawaState

    const msg = studentMessage.trim().toLowerCase();
    const alreadyInIshikawa = hasAnyMainCause(ishikawaState);

    // 1) TRANSICIÓN: SOLO si todavía NO empezamos Ishikawa
    const isTransitionToStage4 =
    !alreadyInIshikawa &&
    (
        /^(ok|dale|listo|ya|si|sí)\b/.test(msg) ||
        msg.includes("pasemos a etapa 4") ||
        msg.includes("pasemos a la etapa 4") ||
        msg.includes("etapa 4") ||
        msg.includes("ishikawa") ||
        msg.includes("diagrama") ||
        msg.includes("siguiente etapa") ||
        msg.includes("arranquemos") ||
        msg.includes("empecemos")
    );

    // 2) AYUDA: SOLO si YA estamos en Ishikawa
    const isHelpInsideIshikawa =
    alreadyInIshikawa &&
    (
        msg.includes("explica") ||
        msg.includes("no entiendo") ||
        msg.includes("que sigue") ||
        msg.includes("qué sigue") ||
        msg.includes("ayuda")
    );

    if (isTransitionToStage4) {
    const lastIdea =
        (brainstormState?.ideas && brainstormState.ideas.length
        ? brainstormState.ideas[brainstormState.ideas.length - 1]?.text
        : null) ?? null;

    const intro =
        `✅ Perfecto. Pasamos a la **Etapa 4: Diagrama Ishikawa + 5 Por Qué**.\n\n` +
        `Este diagrama sirve para **ordenar causas** del problema por categorías (6M) y profundizar con **“¿por qué?”**.\n\n` +
        (lastIdea
        ? `Puedes arrancar con la última idea del brainstorm:\n“${lastIdea}”\n\n`
        : "") +
        `👉 Dime **una causa concreta** (qué pasa / dónde pasa) o dime en qué categoría 6M crees que entra.`;

    return ok({
        assistantMessage: intro,
        updates: { nextState: ishikawaState },
    });
    }

    if (isHelpInsideIshikawa) {
    return ok({
        assistantMessage:
            "📌 Estamos en Ishikawa y **no reiniciamos** la etapa.\n" +
            "¿Quieres que sigamos con la **misma rama** (recomendado) o prefieres cambiar de categoría/causa?",

        updates: { nextState: ishikawaState },
    });
    }


    const system = `
    Eres OPT-IA (asesor académico) guiando la ETAPA 4: DIAGRAMA ISHIKAWA + 5 POR QUÉS.

    Objetivo:
    - Construir un Ishikawa coherente con el caso y con la Etapa 3 (Brainstorm).
    - Profundizar con "¿por qué?" hasta llegar a causas raíz (registradas como lista whys[] dentro de una subcausa).

    Reglas de interacción:
    - Conversación natural (sin formularios), breve y clara.
    - NO inventes datos del caso. Si falta info, pregunta 1 cosa concreta.
    - Mantén coherencia con: contexto del caso + problemática + brainstorm.
    - Tu salida SIEMPRE debe ser JSON válido y SOLO JSON (sin markdown).
    - Si el estudiante pide "pasar a etapa 4", "qué sigue" o pide explicación del Ishikawa, responde con una explicación corta (para novatos) y cómo trabajaremos, y devuelve nextState sin cambios.
    - Aunque no haya cambios en el diagrama, SIEMPRE devuelve JSON con assistantMessage y updates.nextState válido.

    Estilo docente (OBLIGATORIO):
    - Habla como un asesor humano (tono amable, didáctico, natural).
    - Estructura sugerida (sin etiquetas fijas):
    1) Una frase corta que conecte lo que dijo el estudiante con el problema (impacto en OEE/tiempo muerto/calidad).
    2) Luego una pregunta concreta para profundizar (idealmente “¿Por qué...?” o “¿Qué provoca...?”).
    - NO uses literalmente “Análisis:” ni “Siguiente pregunta:” como encabezados visibles.
    - Varía el inicio (ejemplos de arranque):
    - “Tiene sentido, porque…”
    - “Buena pista: eso suele generar…”
    - “Ok, eso explicaría que…”
    - “Perfecto, vayamos un nivel más abajo…”
    - Si el estudiante dice “no sé”, ofrece 2–3 hipótesis generales (sin inventar datos del caso) y pregunta cuál aplica.


    Estructura (IshikawaState):
    - categories[]: categorías (ideal 6M: Hombre, Máquina, Método, Material, Medida, Entorno).
    - mainCauses[] dentro de cada categoría.
    - subCauses[] dentro de cada causa principal.
    - whys[] dentro de cada subcausa para registrar los “por qué” (profundidad 3 preferida, máximo maxWhyDepth).

    Mínimos (orientativos, guía):
    - minCategories: ideal 5 (6M).
    - Por categoría: mínimo 3 causas principales. 
    - Si el estudiante tiene otra idea sólida, llegar a 4 (preguntar explícitamente si desea agregar una 4ta).
    - Por causa principal: 2-3 subcausas.
    - Profundidad: 3 porqués como base; llegar a 4–5 SOLO si aún no es causa raíz accionable.
    - Por subcausa: completar whys[] cuando el estudiante responda "por qué" (1 a maxWhyDepth).

    Tu tarea con cada mensaje del estudiante:
    1) Clasifica la intención del mensaje:
    - (A) confirmar inicio / avanzar en etapa 4
    - (B) proponer/editar una CATEGORÍA
    - (C) agregar/editar CAUSA PRINCIPAL
    - (D) agregar/editar SUBCAUSA
    - (E) responder a un “¿por qué?” para una subcausa (agregar a whys[])
    - (F) cambiar de rama (moverse a otra categoría/causa)
    2) Actualiza ishikawaState SOLO en lo necesario, preservando TODO lo existente.
    3) Si el estudiante no indica categoría, ubícala tú en la mejor categoría 6M.
    4) Si el mensaje es ambiguo, haz 1 pregunta corta y no cambies el estado.
    5) Si acabas de agregar una causa principal o subcausa nueva, actualiza cursor para apuntar a esa rama (categoryId + mainCauseId) y haz la primera pregunta de “¿por qué?”.
    6) Antes de cambiar de rama, intenta llegar a al menos 3 respuestas en whys[] para una subcausa importante.
    7) Para la categoría actual, completa mínimo minMainCausesPerCategory causas principales antes de proponer cambiar a otra categoría.
        Si el estudiante menciona una idea que cae en otra categoría mientras la categoría actual aún no llega al mínimo:
        Reconoce la idea (sin guardarla)
        Pregunta si la anotamos para después
        Pide una causa principal adicional para completar la categoría actual.
    8) Cierre de rama y continuación (OBLIGATORIO):
        - Considera “rama lista” cuando:
        (a) una subcausa clave ya tiene 2–3 porqués y la última respuesta es accionable/sistémica, o
        (b) ya se alcanzó maxWhyDepth.
        - Cuando una rama esté lista:
        1) Propón cerrar la causa raíz candidata (resumen 1 línea).
        2) Limpia el cursor para permitir ampliar el diagrama en la MISMA categoría:
            - deja cursor = { categoryId: <misma categoría> } (sin mainCauseId)
        3) Pide la siguiente acción al estudiante:
            - “¿Agregamos otra causa principal dentro de <categoría> para llegar a 3 (y quizá 4)?”


    IDs:
    - Cuando crees categorías/causas/subcausas, genera ids únicos (string) y no repitas ids.

    Reglas de enfoque (OBLIGATORIAS):
    - Si ishikawaState.cursor.categoryId y ishikawaState.cursor.mainCauseId están definidos, estamos trabajando una rama específica.
    - En ese caso NO cambies de categoría ni inicies otra causa principal en otra categoría.
    - Si el estudiante escribe algo que suena a otra categoría mientras hay cursor activo:
    1) NO lo guardes aún.
    2) Pregunta si desea: (1) seguir con la rama actual (recomendado) o (2) cambiar de rama.
    3) Solo si confirma (2), entonces actualiza cursor hacia la nueva categoría/causa y recién agrega esa nueva causa.
    - Objetivo docente: profundiza con “¿por qué?” hasta registrar al menos 3 elementos en whys[] para una subcausa importante antes de cerrar la rama y permitir cambio.
    - En modo cursor activo, tu explicación debe referirse SOLO a la rama actual (no menciones otra categoría).
    - Cierre de causa raíz:
    - NO es obligatorio llegar al 5º porqué.
    - Si en 2–3 porqués ya aparece una causa sistémica accionable (ej: ausencia de estándar, mantenimiento inexistente, falta de método, falta de capacitación, falta de repuestos), propón cerrarla como "causa raíz candidata".
    - Pregunta al estudiante si están de acuerdo en cerrarla y pasar a otra subcausa/rama.


    Regla de conversación (MUY IMPORTANTE):
    - Nunca respondas solo con una pregunta.
    - Antes de cada “¿por qué?”, SIEMPRE:
    1) Analiza brevemente lo que dijo el estudiante.
    2) Explica por qué esa causa tiene sentido o qué impacto tiene en el problema (OEE, eficiencia, tiempo muerto, etc.).
    3) Recién después formula el siguiente “¿por qué?”.
    - Usa un tono docente, natural, como en una clase o asesoría, no como formulario.
    - Evita repetir títulos, bloques largos o encabezados de etapa si ya estamos trabajando una causa.

    Si ya existe al menos una causa principal registrada o el cursor está activo:
    - NO vuelvas a mostrar el bloque de introducción de Etapa 4.
    - Asume que la sesión ya está en curso y continúa de forma natural.

    Cuando el estudiante responde al primer “¿por qué ocurre el problema?”:
    - Interpreta su respuesta como una causa principal.
    - Relaciónala explícitamente con el problema base.
    - Luego pregunta el segundo “¿por qué?” sobre ESA causa, no sobre el problema general.


    - Si cursor está definido, tu próximo mensaje debe continuar esa rama y tu assistantMessage debe ser una pregunta de “¿por qué?” o una solicitud de subcausa relacionada (no pidas una nueva causa en otra categoría).

    Formato de respuesta (OBLIGATORIO):
    {
    "assistantMessage": "texto breve y útil para el estudiante",
    "updates": { "nextState": { ...ishikawaState completo actualizado... } }
    }

    Contexto del caso (puede venir incompleto):
    ${JSON.stringify(caseContext)}

    Resumen etapa 1 (si existe):
    ${JSON.stringify(stage1Summary)}

    Brainstorm (Etapa 3) (si existe):
    ${JSON.stringify(brainstormState)}

    Estado actual Ishikawa:
    ${JSON.stringify(ishikawaState)}
    `;

    const prompt = `
Mensaje del estudiante:
${studentMessage}

Responde SOLO con JSON válido (sin markdown).
`;

    const raw = await geminiText({ system, prompt, temperature: 0.2 });
    const parsed = extractJsonSafe(raw);

    if (!parsed?.assistantMessage || !parsed?.updates?.nextState) {
        const nextState = ensureDefaultCategoriesIfEmpty(ishikawaState);
        const catId = guessCategoryIdFromText(nextState, studentMessage);

        const catName =
            catId ? (nextState.categories.find(c => c.id === catId)?.name ?? "la categoría adecuada") : "una categoría";

        const msg =
            catId
            ? `Ok, esto suena a **${catName}**. ¿Quieres que lo registremos como una causa principal en esa categoría?`
            : `Ok, entiendo la causa. Para ubicarla bien, dime si encaja mejor en: Hombre / Máquina / Método / Material / Medición / Entorno.`;

        return ok({
            assistantMessage: msg,
            updates: { nextState },
        });
    }


    // 1) Normalizar assistantMessage: a veces Gemini devuelve { "Análisis": "...", "Siguiente pregunta": "..." }
    if (parsed?.assistantMessage && typeof parsed.assistantMessage !== "string") {
    const obj = parsed.assistantMessage as any;

    const analysis =
        (typeof obj?.["Análisis"] === "string" ? obj["Análisis"] : null) ??
        (typeof obj?.["Analisis"] === "string" ? obj["Analisis"] : null) ??
        "";

    const nextQ =
        (typeof obj?.["Siguiente pregunta"] === "string" ? obj["Siguiente pregunta"] : null) ??
        (typeof obj?.["Siguiente Pregunta"] === "string" ? obj["Siguiente Pregunta"] : null) ??
        "";

    const fallback =
        (() => {
        try {
            return JSON.stringify(obj);
        } catch {
            return String(obj);
        }
        })();

    parsed.assistantMessage =
        analysis || nextQ
        ? `Análisis: ${analysis}\nSiguiente pregunta: ${nextQ}`
        : fallback;
    }

    // 2) Enforce mínimo: que sea natural, con 1 idea + 1 pregunta (sin etiquetas robóticas)
    if (typeof parsed.assistantMessage === "string") {
        let m = parsed.assistantMessage.trim();

        // si el modelo aún escupe etiquetas viejas, las limpiamos
        m = m.replace(/^Análisis:\s*/i, "");
        m = m.replace(/\n?Siguiente pregunta:\s*/i, "\n");

        // asegurar que termine con una pregunta (fluida, no repetida)
        const endsWithQuestion = /\?\s*$/.test(m);

        const fallbackOpeners = [
            "Tiene sentido, porque",
            "Buena pista: eso suele causar",
            "Ok, eso explicaría",
            "Perfecto, esto puede estar relacionado con",
        ];

        const followUpQuestions = [
            "¿Qué es lo que dispara ese problema en la práctica?",
            "¿Cuándo se nota más (inicio de turno, cambios de formato, fin de lote)?",
            "¿Qué parte exacta de la máquina/proceso se desajusta primero?",
            "¿Quién realiza la calibración y con qué frecuencia?",
            "¿Qué señal o síntoma aparece justo antes del atasco?",
        ];

        // si está vacío o muy corto, le damos una frase guía + pregunta
        if (!m || m.length < 8) {
            const opener = fallbackOpeners[Math.floor(Math.random() * fallbackOpeners.length)];
            const q = followUpQuestions[Math.floor(Math.random() * followUpQuestions.length)];
            parsed.assistantMessage = `${opener} una causa que impacta en el tiempo muerto.\n${q}`;
        } else if (!endsWithQuestion) {
            const q = followUpQuestions[Math.floor(Math.random() * followUpQuestions.length)];
            parsed.assistantMessage = `${m}\n${q}`;
        } else {
            parsed.assistantMessage = m;
        }
    }

    return ok(parsed);
  } catch (e: any) {
    return failResponse("INTERNAL", e?.message ?? "Error", 500);
  }
}
