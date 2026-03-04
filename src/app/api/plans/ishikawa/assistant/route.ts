//src/app/api/plans/ishikawa/assistant/route.ts

import { ok, failResponse } from "@/lib/api/response";
import { getGeminiModel } from "@/lib/geminiClient";
import { requireUser } from "@/lib/auth/supabase";

export const runtime = "nodejs";

function makeRequestId() {
  return `ish_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

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


function countRootCandidates(state: any) {
  const cats = Array.isArray(state?.categories) ? state.categories : [];
  const roots: string[] = [];

  for (const c of cats) {
    const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];

    for (const m of mains) {
      const subs = Array.isArray(m?.subCauses) ? m.subCauses : [];

      for (const s of subs) {
        const whys = Array.isArray(s?.whys) ? s.whys : [];

        const normalizedWhys = whys
          .map((w: any) => (typeof w === "string" ? w : (w?.text ?? "")))
          .map((t: any) => (t ?? "").toString().trim())
          .filter(Boolean);

        // Si hay 5-porqués, la raíz candidata es el último porqué
        if (normalizedWhys.length > 0) {
          const last = normalizedWhys[normalizedWhys.length - 1];
          if (last) roots.push(last);
          continue;
        }

        // Fallback: si no hay whys, cuenta la subcausa como candidata
        const t = (s?.text ?? s?.name ?? "").toString().trim();
        if (t) roots.push(t);
      }
    }
  }

  return roots;
}

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

function normalizeWhyText(input: string) {
  let t = (input ?? "").trim();

  t = t.replace(/^(si|sí|pues|bueno|ok|mmm)\s*,?\s*/i, "");
  t = t.replace(/^(creo que|pienso que|diría que)\s+/i, "");
  t = t.replace(/^(porque|por que)\s+/i, "");

  if (t.length) t = t[0].toUpperCase() + t.slice(1);

  return t;
}

function isVagueWhyAnswer(input: string) {
  const t = (input ?? "").trim().toLowerCase();
  if (!t) return true;

  // Muy corto = probablemente poco útil
  if (t.length < 10) return true;

  // Respuestas típicas vagas
  if (
    /^(no se|no sé|ni idea|nose|quiz(a|á)|tal vez|creo|pienso|supongo|puede ser|por ahi|por ahí)/.test(t)
  ) {
    return true;
  }

  // Frases tipo "por mirar / a ojo" sin causa concreta
  if (/(por mirar|a ojo|solo mirando|me parece|como que)/.test(t)) return true;

  return false;
}

function isNonCausalMessage(input: string) {
  const t = (input ?? "").toLowerCase().trim();
  if (!t) return true;

  // Intenciones de navegación / control
  if (
    t.includes("continuemos") ||
    t.includes("sigamos") ||
    t.includes("ahora trabajemos") ||
    t.includes("ahora quiero trabajar") ||
    t.includes("pasemos a") ||
    t.includes("siguiente categoria") ||
    t.includes("otra categoria") ||
    t.includes("material") ||
    t.includes("metodo") ||
    t.includes("maquina") ||
    t.includes("mano de obra")
  ) {
    return true;
  }

  // Preguntas meta
  if (
    t.startsWith("que temas") ||
    t.startsWith("qué temas") ||
    t.startsWith("en que estamos") ||
    t.startsWith("qué estamos viendo") ||
    t.includes("que causa estamos")
  ) {
    return true;
  }

  return false;
}

function buildClarifyWhyMessage(studentMessage: string) {
  const raw = (studentMessage ?? "").trim();
  const t = raw.toLowerCase();

  // Tomamos el texto normalizado pero lo "profesionalizamos" (sin jejeje/jaja/xd)
  const hint0 = normalizeWhyText(raw);
  const hint = hint0
    .replace(/\b(jeje+|jaja+|haha+|xd+|xD+)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Detectar tema para que las opciones SÍ tengan sentido
  const topic =
    /(pago|salari|sueldo|bono|incentiv|remuner|comisi)/.test(t) ? "comp" :
    /(inter[eé]s|desmotiv|motiv|clima|cultura|actitud)/.test(t) ? "mot" :
    /(supervis|jefe|encargad|lider|control|seguim|disciplina)/.test(t) ? "lead" :
    /(manual|sop|proced|est[aá]ndar|instruct|checklist)/.test(t) ? "std" :
    /(capacit|inducci|entren|formaci)/.test(t) ? "trn" :
    /(manten|inspecci|lubric|desgaste|calibr|falla|aver[ií]a)/.test(t) ? "mnt" :
    /(recurso|presup|dinero|tiempo|personal|apoyo)/.test(t) ? "res" :
    "gen";

  const optionsByTopic: Record<string, string[]> = {
    comp: [
      "Pago/bono no está ligado al desempeño (no hay incentivo por orden, disciplina o productividad)",
      "Pagos atrasados o variabilidad en pagos (afecta asistencia/compromiso)",
      "Percepción de inequidad salarial (desmotiva y baja el seguimiento)",
      "No existen metas/KPIs claros para el rol del supervisor (no se prioriza control/orden)",
    ],
    mot: [
      "Cultura sin disciplina operativa (no hay hábitos de orden/5S sostenidos)",
      "Falta de reglas claras y consecuencias (se tolera el desorden)",
      "Alta rotación o baja cohesión (nadie “se hace cargo” del estándar)",
      "El equipo no ve impacto/beneficio de mantener orden (no hay retroalimentación)",
    ],
    lead: [
      "No hay rutina de supervisión (rondas, checklist, reuniones cortas de seguimiento)",
      "Roles y responsables poco claros (nadie es dueño del orden del área)",
      "Supervisor sin herramientas/metodología (no sabe cómo controlar/estandarizar)",
      "No existen indicadores visibles (tiempos, paros menores, 5S, auditorías)",
    ],
    std: [
      "No existe SOP/checklist (cada operador trabaja a su manera)",
      "Existe SOP, pero no se cumple (falta control/auditoría)",
      "El procedimiento no es claro o no está disponible en el puesto",
      "Cambios de turno/formatos sin estándar de set-up/limpieza",
    ],
    trn: [
      "No hay inducción formal (aprenden 'por mirar')",
      "No hay matriz de habilidades/certificación por puesto",
      "Capacitación es ocasional y sin material (SOP/guía/checklist)",
      "Supervisor no tiene tiempo/estructura para capacitar (no hay rutina)",
    ],
    mnt: [
      "Mantenimiento preventivo insuficiente (solo correctivo)",
      "Fallas recurrentes sin análisis de causa (se repiten paros)",
      "Falta inspección/ajustes antes de operar (condición del equipo)",
      "No hay repuestos/planificación para fallas típicas",
    ],
    res: [
      "Falta de personal/tiempo para sostener orden y seguimiento",
      "Demanda alta/urgencias desplazan tareas de control (5S, capacitación, inspección)",
      "No hay herramientas/espacio definido (orden difícil de mantener)",
      "El supervisor está saturado (no puede ejecutar rutina de control)",
    ],
    gen: [
      "Falta de estándar (no hay un 'modo único' de hacerlo)",
      "Falta de control/seguimiento (no se verifica cumplimiento)",
      "Falta de capacitación/inducción (no dominan el método)",
      "Falta de recursos/tiempo (se deja de hacer lo necesario)",
    ],
  };

  const opts = optionsByTopic[topic] ?? optionsByTopic.gen;

  const numbered =
    opts.slice(0, 4).map((o, i) => `${i + 1}) ${o}`).join("\n");

  return (
    `Entiendo tu punto${hint ? ` (**${hint}**)` : ""}, pero aún está **muy general**.\n` +
    `Para volverlo una causa raíz accionable, necesito que lo concretes como: **mecanismo + evidencia**.\n\n` +
    `Elige UNA opción (o escribe una propia más precisa):\n` +
    `${numbered}\n\n` +
    `👉 ¿Cuál aplica más en tu caso y qué evidencia concreta tienes? (ej.: “no hay checklist”, “no hay rutina de supervisión”, “pagos atrasados 2 semanas”, “no hay KPI del supervisor”).`
  );
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

function hasAnyIshikawaWork(state: IshikawaState) {
  if (state.cursor?.categoryId) return true;

  return Array.isArray(state.categories) && state.categories.some((c) =>
    (c.mainCauses ?? []).some((mc) =>
      (mc.subCauses ?? []).some((sc) => (sc.whys?.length ?? 0) > 0 || (sc.name ?? sc.text))
    )
  );
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

function buildIshikawaMap(state: any) {
  const cats = Array.isArray(state?.categories) ? state.categories : [];

  const minCats = state?.minCategories ?? 4;
  const minMain = state?.minMainCausesPerCategory ?? 3; // OJO: si quieres 2, cambia aquí a 2
  const minSub = state?.minSubCausesPerMain ?? 1; // recomendado 1 si usan 5-porqués

  const isPlaceholder = (s: string) => {
    const t = (s ?? "").toString().trim().toLowerCase();
    return !t || t === "causa" || t === "subcausa";
  };

  const labelMain = (mc: any) => {
    const raw = (mc?.name ?? mc?.text ?? "").toString().trim();
    return isPlaceholder(raw) ? "(sin nombre de causa principal)" : raw;
  };

  const labelSub = (sc: any) => {
    const raw = (sc?.name ?? sc?.text ?? "").toString().trim();
    return isPlaceholder(raw) ? "(sin nombre de subcausa)" : raw;
  };

  const normalizeWhys = (sc: any) => {
    const whys = Array.isArray(sc?.whys) ? sc.whys : [];
    return whys
      .map((w: any) => (typeof w === "string" ? w : (w?.text ?? "")))
      .map((t: any) => (t ?? "").toString().trim())
      .filter(Boolean);
  };

  // Causa raíz candidata = último porqué (si existe), si no la subcausa
  const roots: string[] = [];
  for (const c of cats) {
    const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];
    for (const m of mains) {
      const subs = Array.isArray(m?.subCauses) ? m.subCauses : [];
      for (const s of subs) {
        const whys = normalizeWhys(s);
        if (whys.length > 0) {
          roots.push(whys[whys.length - 1]);
        } else {
          const t = (s?.text ?? s?.name ?? "").toString().trim();
          if (t && !isPlaceholder(t)) roots.push(t);
        }
      }
    }
  }

  // Subcausa válida si tiene nombre útil o al menos 1 porqué útil
  const isSubValid = (sc: any) => {
    const n = (sc?.name ?? sc?.text ?? "").toString().trim();
    if (n && !isPlaceholder(n)) return true;
    const whys = normalizeWhys(sc);
    return whys.length > 0;
  };

  // Causa principal completa si tiene minSub subcausas válidas
  const isMainComplete = (mc: any) => {
    const subs = Array.isArray(mc?.subCauses) ? mc.subCauses : [];
    const validSubs = subs.filter(isSubValid);
    return validSubs.length >= minSub;
  };

  // Categoría completa si tiene minMain causas principales completas
  const mainCompleteCount = (cat: any) => {
    const mains = Array.isArray(cat?.mainCauses) ? cat.mainCauses : [];
    return mains.filter(isMainComplete).length;
  };

  const completeCats = cats.filter((c: any) => mainCompleteCount(c) >= minMain);

  const lines: string[] = [];

  lines.push("📊 Progreso mínimo del Ishikawa");
  lines.push(`Categorías completas: ${completeCats.length}/${minCats}`);
  lines.push(`Causas raíz identificadas: ${roots.length}/10`);
  lines.push("");

  if (completeCats.length >= minCats && roots.length >= 10) {
    lines.push("✅ Ya cumples los mínimos para pasar a Pareto.");
  } else {
    lines.push("🧩 Para poder pasar a Pareto te falta:");
    if (completeCats.length < minCats) {
      lines.push(`- Completar al menos ${minCats} categorías (con ${minMain} causas principales completas cada una)`);
    }
    if (roots.length < 10) {
      lines.push(`- Identificar ${10 - roots.length} causas raíz adicionales`);
    }
  }

  lines.push("");
  lines.push("📌 Estado por categoría");
  for (const c of cats) {
    const done = mainCompleteCount(c);
    const ok = done >= minMain;
    lines.push(`${ok ? "✅" : "❌"} ${c?.name ?? "Categoría"} — causas completas: ${done}/${minMain}`);
  }

  lines.push("");
  lines.push("🗺️ Mapa Ishikawa");
  lines.push("");

  // Indentación SOLO por espacios (no líneas). Usamos NBSP para que no se colapse.
  const i2 = "\u00A0\u00A0";
  const i4 = "\u00A0\u00A0\u00A0\u00A0";
  const i6 = "\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0";

  for (const c of cats) {
    lines.push(`▶ ${c?.name ?? "Categoría"}`);

    const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];
    for (const mc of mains) {
      lines.push(`${i2}◆ ${labelMain(mc)}`);

      const subs = Array.isArray(mc?.subCauses) ? mc.subCauses : [];
      for (const sc of subs) {
        lines.push(`${i4}- ${labelSub(sc)}`);

        const whys = normalizeWhys(sc);
        for (let k = 0; k < whys.length; k++) {
          lines.push(`${i6}${k + 1}) ${whys[k]}`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function normalizeText(x: unknown) {
  return (typeof x === "string" ? x : "").trim();
}

function mergeIshikawaState(prev: IshikawaState, incoming: IshikawaState): IshikawaState {
  // 1) Problema: no dejar que se borre
  const prevProblem =
    typeof prev.problem === "string" ? prev.problem : prev.problem?.text ?? "";
  const incProblem =
    typeof incoming.problem === "string" ? incoming.problem : incoming.problem?.text ?? "";

  const problemText = normalizeText(incProblem) || normalizeText(prevProblem);

  // 2) Categorías por ID: preservar prev y aplicar incoming por id
  const prevCats = prev.categories ?? [];
  const incCats = incoming.categories ?? [];

  const prevById = new Map(prevCats.map(c => [c.id, c]));
  const outCats: IshikawaCategory[] = [];

  // primero, recorremos incoming (aplica cambios)
  for (const ic of incCats) {
    const pc = prevById.get(ic.id);

    if (!pc) {
      // categoría nueva
      outCats.push(ic);
      continue;
    }

    // merge mainCauses por id
    const prevMainById = new Map((pc.mainCauses ?? []).map(m => [m.id, m]));
    const mergedMain: IshikawaCategory["mainCauses"] = [];

    for (const im of ic.mainCauses ?? []) {
      const pm = prevMainById.get(im.id);
      if (!pm) {
        mergedMain.push(im);
        continue;
      }

      // merge subCauses por id
      const prevSubById = new Map((pm.subCauses ?? []).map(s => [s.id, s]));
      const mergedSub: typeof pm.subCauses = [];

      for (const is of im.subCauses ?? []) {
        const ps = prevSubById.get(is.id);
        if (!ps) {
          mergedSub.push(is);
          continue;
        }

        // whys: si incoming trae whys vacío, conservar prev
        const incWhys = Array.isArray(is.whys) ? is.whys : [];
        const prevWhys = Array.isArray(ps.whys) ? ps.whys : [];
        const whys = incWhys.length ? incWhys : prevWhys;

        mergedSub.push({
          ...ps,
          ...is,
          whys,
        });

        prevSubById.delete(is.id);
      }

      // agregar subcauses que existían antes y no vinieron en incoming (no borrar)
      for (const leftover of prevSubById.values()) mergedSub.push(leftover);

      mergedMain.push({
        ...pm,
        ...im,
        subCauses: mergedSub,
      });

      prevMainById.delete(im.id);
    }

    // agregar maincauses prev que no vinieron (no borrar)
    for (const leftover of prevMainById.values()) mergedMain.push(leftover);

    outCats.push({
      ...pc,
      ...ic,
      mainCauses: mergedMain,
    });

    prevById.delete(ic.id);
  }

  // luego, agregamos categorías prev que no vinieron (no borrar)
  for (const leftover of prevById.values()) outCats.push(leftover);

  return {
    ...prev,
    ...incoming,
    problem: problemText ? { text: problemText } : prev.problem,
    categories: outCats,
  };
}


function isShortFastPathCandidate(text: string) {
  const t = (text ?? "").trim();
  if (!t) return false;

  const lower = t.toLowerCase();

  // No fast-path si está pidiendo explicación o resumen
  if (
    lower.includes("explica") ||
    lower.includes("no entiendo") ||
    lower.includes("ayuda") ||
    lower.includes("resumen") ||
    lower.includes("mapa") ||
    lower.includes("situacion actual") ||
    lower.includes("situación actual")
  ) {
    return false;
  }

  // Si es pregunta o muy largo, mejor LLM
  if (t.includes("?")) return false;
  if (t.length > 100) return false;

  return true;
}

function isCloseBranchConfirm(text: string) {
  const t = (text ?? "").toLowerCase();
  return /(cerrar|cerremos|cerramos|cerrar ahi|cerrar ahí|de acuerdo cerrar|ok cerrar|si.*cerr)/.test(t);
}

function findActiveNodes(state: IshikawaState) {
  const catId = state.cursor?.categoryId;
  const mcId = state.cursor?.mainCauseId;
  const scId = state.cursor?.subCauseId;

  if (!catId || !mcId) return null;

  const cat = state.categories.find((c) => c.id === catId);
  if (!cat) return null;

  const mc = cat.mainCauses.find((m) => m.id === mcId);
  if (!mc) return null;

  const sc = scId ? mc.subCauses.find((s) => s.id === scId) : null;

  return { cat, mc, sc };
}

function safeClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}


function pick<T>(arr: T[], seed: string): T {
  // pseudo-random estable por mensaje (evita repetir siempre el primero)
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

function buildVariedFollowUp(studentMessage: string) {
  const raw = (studentMessage ?? "").trim();
  const t = raw.toLowerCase();

  const key = normalizeWhyText(raw);
  const keyShort = key.length > 70 ? key.slice(0, 70).trim() + "…" : key;

  const topic =
    /(pago|salari|sueldo|bono|incentiv|remuner)/.test(t) ? "comp" :
    /(inter[eé]s|desmotiv|motiv|clima|cultura|actitud)/.test(t) ? "mot" :
    /(supervis|jefe|encargad|lider|control|seguim)/.test(t) ? "lead" :
    /(manual|sop|proced|est[aá]ndar|instruct|checklist)/.test(t) ? "std" :
    /(manten|inspecci|lubric|desgaste|calibr|falla|aver[ií]a)/.test(t) ? "mnt" :
    /(recurso|presup|dinero|tiempo|personal|apoyo)/.test(t) ? "res" :
    /(capacit|inducci|entren|formaci)/.test(t) ? "trn" :
    "gen";

  const openersBase = [
    "Bien, eso apunta a una causa plausible.",
    "Perfecto, esa pista es relevante.",
    "Ok, vamos bien: esto puede explicar parte del problema.",
    "Entendido. Esto nos ayuda a aterrizar la causa.",
    "De acuerdo; ahora lo volvemos más accionable.",
  ];

  const analysisByTopic: Record<string, string[]> = {
    comp: [
      `Esto sugiere un tema de **incentivos/remuneración** que puede afectar compromiso y disciplina operativa.`,
      `Esto parece conectado con **remuneración o incentivos**: cuando no hay reconocimiento, suele caer el control y el orden.`,
      `Esto apunta a **motivación extrínseca** (pago/bonos) y puede traducirse en menos seguimiento y más variabilidad.`,
      `Esto puede ser una causa sistémica: si la retribución no está alineada, se deteriora el desempeño sostenido.`,
    ],
    mot: [
      `Esto apunta a **motivación/cultura**: cuando el equipo no está alineado, suben desorden y retrabajos.`,
      `Esto sugiere un tema de **clima/cultura** que termina afectando disciplina y tiempos de búsqueda.`,
      `Esto parece un problema de **comportamiento organizacional**: la disciplina cae si no hay reglas claras y seguimiento.`,
      `Esto podría ser más “gestión” que “técnico”: falta de hábitos y control operativo.`,
    ],
    lead: [
      `Esto sugiere un punto de **liderazgo y control operativo** (seguimiento, roles, consecuencias).`,
      `Esto apunta a un problema de **gestión del supervisor**: sin seguimiento, el estándar se diluye.`,
      `Esto puede ser una causa raíz típica: **roles/KPIs** poco claros y control inconsistente.`,
      `Esto indica una brecha de **supervisión** que se convierte en desorden y variabilidad.`,
    ],
    std: [
      `Esto sugiere falta de **estandarización (SOP/checklist)**, lo que genera variabilidad y paros.`,
      `Esto apunta a ausencia de **procedimiento definido**, por eso el resultado depende de “quién lo hace”.`,
      `Esto es típico de falta de estándar: sin SOP, aparecen errores y tiempos perdidos por improvisación.`,
      `Esto conecta con estandarización: sin reglas claras, el proceso se vuelve variable y sube el tiempo muerto.`,
    ],
    mnt: [
      `Esto sugiere un tema de **condición del equipo / mantenimiento**, que impacta directamente en paradas.`,
      `Esto apunta a **fallas por mantenimiento/ajustes**, y suele evidenciarse en arranques inestables.`,
      `Esto puede indicar falta de **inspección preventiva** o calibración; se traduce en paros repetitivos.`,
      `Esto parece técnico: si el equipo está fuera de condición, la línea pierde disponibilidad.`,
    ],
    res: [
      `Esto apunta a una restricción de **recursos/tiempo/personal** que termina afectando el control y la ejecución.`,
      `Esto sugiere saturación: sin recursos, se sacrifica orden, capacitación o mantenimiento.`,
      `Esto suele ser causa raíz: falta de capacidad para sostener disciplina operativa.`,
      `Esto conecta con la gestión diaria: cuando falta tiempo/personal, el estándar se deja de cumplir.`,
    ],
    trn: [
      `Esto sugiere una brecha de **capacitación/inducción**, que genera variabilidad en cómo se trabaja.`,
      `Esto apunta a falta de **formación operativa**, por eso hay diferencias entre operadores.`,
      `Esto suele generar errores y tiempos muertos: sin entrenamiento, el proceso no se ejecuta igual.`,
      `Esto conecta con estandarización + entrenamiento: si no se enseña el método, cada uno improvisa.`,
    ],
    gen: [
      `Esto ayuda a explicar parte del tiempo muerto y la baja de eficiencia.`,
      `Esto encaja como una causa plausible dentro del Ishikawa.`,
      `Esto puede estar contribuyendo al problema, pero necesitamos concretarlo.`,
      `Esto es una buena hipótesis; ahora hay que bajarla a un mecanismo concreto.`,
    ],
  };

  const questionsByTopic: Record<string, string[]> = {
    comp: [
      "¿Qué pasa en la práctica por el tema de pago: rotación, ausentismo, baja disciplina, menor seguimiento?",
      "¿Es un tema de salario base, bonos por rendimiento, o pagos atrasados? ¿Cuál ocurre aquí?",
      "¿Cómo se refleja esto en el proceso (más retrabajo, menos orden, más tiempos de búsqueda)?",
      "¿Qué evidencia tienes (quejas, rotación, faltas, baja productividad) y desde cuándo ocurre?",
      "Si se corrigiera el incentivo/pago, ¿qué comportamiento esperas que cambie primero?",
    ],
    mot: [
      "¿Qué comportamiento observas exactamente (incumplimiento, desorden, retrabajo, falta de cuidado)?",
      "¿Hay reglas claras y consecuencias, o cada turno trabaja distinto?",
      "¿Qué indicador te muestra el impacto (tiempos de búsqueda, paros menores, retrabajo)?",
      "¿Esto ocurre en todos los turnos o solo en uno? ¿Qué cambia entre turnos?",
      "¿Qué acción concreta falta (5S, auditoría, líder de turno, rutina de control)?",
    ],
    lead: [
      "¿Qué parte del control falla: asignación de roles, seguimiento, retroalimentación, disciplina?",
      "¿Qué debería controlar el supervisor (checklist, rondas, KPI) y hoy no se controla?",
      "¿Por qué no se hace seguimiento: falta de tiempo, falta de método, falta de autoridad, falta de KPI?",
      "¿Qué evidencia lo muestra (no hay reuniones de 5 min, no hay checklist, no hay registro)?",
      "¿Quién es el dueño del área y qué rutina de control debería existir?",
    ],
    std: [
      "¿Qué parte del procedimiento no está definido (orden, limpieza, set-up, arranque, control de calidad)?",
      "¿Existe SOP y no se cumple, o directamente no existe? ¿Cuál es tu caso?",
      "¿Qué paso se hace distinto entre operadores/turnos?",
      "¿Qué evidencia hay (no hay instructivo visible, nadie sabe el estándar, no hay checklist)?",
      "Si tuvieras que escribir el checklist, ¿cuáles serían 3 puntos críticos?",
    ],
    mnt: [
      "¿Qué falla exactamente (sensor, motor, guías, ajuste, lubricación) y con qué frecuencia?",
      "¿Qué ocurre en el arranque vs. en operación continua? (solo al encender / durante el turno)",
      "¿Hay mantenimiento preventivo planificado o es solo correctivo?",
      "¿Qué evidencia tienes (paros repetidos, historial de fallas, piezas desgastadas)?",
      "¿Qué condición del equipo se deja de revisar antes de iniciar turno?",
    ],
    res: [
      "¿Qué recurso falta exactamente (tiempo, personal, herramientas, presupuesto) y en qué actividad impacta?",
      "¿Qué se está dejando de hacer por falta de tiempo (orden, capacitación, inspección, control)?",
      "¿Qué tarea se queda sin dueño cuando hay urgencias?",
      "¿Esto es constante o por picos de demanda? ¿Cuándo empeora?",
      "Si tuvieras 1 recurso adicional, ¿qué priorizarías para bajar el tiempo muerto?",
    ],
    trn: [
      "¿Qué parte de la capacitación falta (operación, arranque, ajustes, calidad, seguridad)?",
      "¿Hay inducción formal o es aprendizaje ‘por mirar’?",
      "¿Quién debería capacitar y qué material falta (SOP, guía, checklist, entrenamiento práctico)?",
      "¿En qué operación se ve más el efecto (set-up, limpieza, arranque, cambio de formato)?",
      "¿Esto afecta a nuevos ingresos o también a personal antiguo?",
    ],
    gen: [
      "¿Cuál es la razón más concreta por la que eso ocurre en tu caso?",
      "¿Qué pasa justo antes de que ocurra ese problema?",
      "¿Qué evidencia lo muestra (tiempos, registros, observación directa)?",
      "¿Ocurre siempre o en ciertos turnos/condiciones?",
      "Si tuvieras que resumirlo en una causa accionable, ¿cómo lo dirías?",
    ],
  };

  const opener = pick(openersBase, raw + "|op");
  const analysis = pick(analysisByTopic[topic] ?? analysisByTopic.gen, raw + "|a|" + topic);
  const q = pick(questionsByTopic[topic] ?? questionsByTopic.gen, raw + "|q|" + topic);

  // Respuesta corta, docente, variada, sin eco literal del mensaje
  return `${opener} ${analysis}\n${q}`;
}

type IshikawaIntent =
  | "SHOW_MAP"
  | "HELP"
  | "ADVANCE_STAGE"
  | "CLOSE_BRANCH"
  | "NON_CAUSAL"
  | "CAUSE_OR_WHY"
  | "UNKNOWN";

function classifyIntentRules(msgLower: string): IshikawaIntent {
  if (!msgLower.trim()) return "UNKNOWN";

  // MAPA / AVANCE / ESTADO
  if (
    msgLower.includes("situacion actual") ||
    msgLower.includes("situación actual") ||
    msgLower.includes("mapa") ||
    msgLower.includes("estado actual") ||
    msgLower.includes("resumen") ||
    msgLower.includes("que tenemos") ||
    msgLower.includes("qué tenemos") ||
    msgLower.includes("en que rama") ||
    msgLower.includes("en qué rama") ||
    msgLower.includes("avance") ||
    msgLower.includes("progreso") ||
    msgLower.includes("muéstrame") ||
    msgLower.includes("muestrame") ||
    msgLower.includes("hasta donde") ||
    msgLower.includes("donde continuar") ||
    msgLower.includes("dónde continuar")
  ) return "SHOW_MAP";

  // AYUDA
  if (
    msgLower.includes("ayuda") ||
    msgLower.includes("no entiendo") ||
    msgLower.includes("explica") ||
    msgLower.includes("qué sigue") ||
    msgLower.includes("que sigue")
  ) return "HELP";

  // AVANZAR/EMPEZAR ETAPA 4
  if (isAdvanceToStage4Message(msgLower)) return "ADVANCE_STAGE";

  // CERRAR RAMA
  if (isCloseBranchConfirm(msgLower)) return "CLOSE_BRANCH";

  // MENSAJE NO CAUSAL (control/navegación)
  if (isNonCausalMessage(msgLower)) return "NON_CAUSAL";

  return "UNKNOWN";
}

async function classifyIntentAI(studentMessage: string): Promise<IshikawaIntent> {
  // Clasificador mínimo: barato y estable. NO edita estado.
  const system =
    `Clasifica el mensaje del estudiante en UNA de estas etiquetas EXACTAS:\n` +
    `SHOW_MAP, HELP, ADVANCE_STAGE, CLOSE_BRANCH, NON_CAUSAL, CAUSE_OR_WHY, UNKNOWN.\n` +
    `Responde SOLO la etiqueta.`;

  const prompt =
    `Mensaje: ${studentMessage}\n\n` +
    `Etiqueta:`;

  try {
    const raw = await geminiText({ system, prompt, temperature: 0 });
    const label = (raw ?? "").trim().toUpperCase();

    if (
      label === "SHOW_MAP" ||
      label === "HELP" ||
      label === "ADVANCE_STAGE" ||
      label === "CLOSE_BRANCH" ||
      label === "NON_CAUSAL" ||
      label === "CAUSE_OR_WHY" ||
      label === "UNKNOWN"
    ) {
      return label as IshikawaIntent;
    }
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

async function classifyIntent(studentMessage: string): Promise<IshikawaIntent> {
  const msgLower = studentMessage.trim().toLowerCase();
  const ruleIntent = classifyIntentRules(msgLower);
  if (ruleIntent !== "UNKNOWN") return ruleIntent;

  // Si no matchea reglas, usamos IA solo para clasificar
  const aiIntent = await classifyIntentAI(studentMessage);
  return aiIntent;
}

function buildUnknownIntentMessage(state: IshikawaState) {
  const nextState = ensureDefaultCategoriesIfEmpty(state);
  const active = findActiveNodes(nextState);

  const problemText =
    typeof nextState.problem === "string"
      ? nextState.problem
      : nextState.problem?.text ?? "";

  // Mensaje fluido, sin opciones tipo bot
  // 1) Si hay rama activa: guiamos a retomar ahí
  if (active?.cat && active?.mc) {
    const catName = active.cat.name ?? "la categoría actual";
    const mcName = active.mc.name ?? active.mc.text ?? "esta causa";

    return {
      assistantMessage:
        `Te sigo 👍. Para no perder el hilo, dime qué prefieres hacer:\n\n` +
        `• Si solo quieres ver dónde vas, dime: **"muéstrame el avance"**.\n` +
        `• Si quieres continuar, sigamos en la rama actual: **${catName} → ${mcName}**.\n\n` +
        `Ahora dime una razón concreta del tipo: “ocurre porque ___” (qué pasa / dónde / cuándo).`,
      nextState,
    };
  }

  // 2) Si NO hay rama activa: pedimos una causa concreta o pedir avance
  return {
    assistantMessage:
      `Te entiendo 👍.\n\n` +
      (problemText ? `🎯 Estamos trabajando el problema: **${problemText}**.\n\n` : "") +
      `Si quieres, puedo mostrarte tu avance (dime **"muéstrame el avance"**).\n` +
      `Si lo que quieres es seguir construyendo el Ishikawa, dime una **causa concreta** del problema (qué pasa / dónde / cuándo).`,
    nextState,
  };
}

function buildLLMStateContext(state: IshikawaState) {
  const cursor = state.cursor;

  // si no hay cursor devolvemos estado resumido
  if (!cursor?.categoryId) {
    return {
      cursor: null,
      categories: (state.categories ?? []).slice(0, 3).map((c) => ({
        id: c.id,
        name: c.name,
        mainCausesCount: c.mainCauses?.length ?? 0,
      })),
    };
  }

  const cat = state.categories.find(c => c.id === cursor.categoryId);
  if (!cat) return { cursor: null, categories: [] };

  const mc = cat.mainCauses.find(m => m.id === cursor.mainCauseId);
  const sc = mc?.subCauses.find(s => s.id === cursor.subCauseId);

  return {
    cursor: state.cursor,

    category: {
      id: cat.id,
      name: cat.name
    },

    mainCause: mc ? {
      id: mc.id,
      name: mc.name ?? mc.text ?? ""
    } : null,

    subCause: sc ? {
      id: sc.id,
      name: sc.name ?? sc.text ?? "",
      whys: (sc.whys ?? []).map(w => typeof w === "string" ? w : w.text)
    } : null,

    // otras categorías solo como resumen
    otherCategories: (state.categories ?? [])
      .filter(c => c.id !== cat.id)
      .slice(0, 2)
      .map(c => ({
        id: c.id,
        name: c.name,
        mainCausesCount: c.mainCauses?.length ?? 0
      }))
  };
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

    const intent = await classifyIntent(studentMessage);

    // ✅ Si la intención quedó "UNKNOWN", NO dispares el prompt gigante.
    // Mejor aclaramos de forma fluida y seguimos sin romper el estado.
    if (intent === "UNKNOWN") {
      const { assistantMessage, nextState } = buildUnknownIntentMessage(ishikawaState);

      return ok({
        assistantMessage,
        updates: { nextState },
      });
    }


    // ✅ 1) Asegurar que el problema SIEMPRE esté en ishikawaState (si viene vacío)
    const currentProblem =
      typeof ishikawaState.problem === "string"
        ? ishikawaState.problem
        : ishikawaState.problem?.text ?? "";

    const ctxProblem =
      (typeof caseContext?.problem === "string" ? caseContext.problem : "") ||
      (typeof caseContext?.problemText === "string" ? caseContext.problemText : "") ||
      (typeof caseContext?.problema === "string" ? caseContext.problema : "") ||
      (typeof stage1Summary?.problem === "string" ? stage1Summary.problem : "") ||
      (typeof stage1Summary?.problemText === "string" ? stage1Summary.problemText : "") ||
      (typeof stage1Summary?.problema === "string" ? stage1Summary.problema : "");

    if (!currentProblem.trim() && ctxProblem.trim()) {
      ishikawaState.problem = { text: ctxProblem.trim() };
    }

    if (intent === "SHOW_MAP") {
      const nextState = ensureDefaultCategoriesIfEmpty(ishikawaState);
      return ok({
        assistantMessage: buildIshikawaMap(nextState),
        updates: { nextState },
      });
    }

    // 0) Si el estudiante está confirmando avanzar a Etapa 4, damos introducción y arrancamos
    if (intent === "ADVANCE_STAGE" && !hasAnyIshikawaWork(ishikawaState)) {
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
    const alreadyInIshikawa = hasAnyIshikawaWork(ishikawaState);


    // ✅ FAST-PATH: si ya estamos en Ishikawa y el mensaje es corto, evitamos Gemini
    if (alreadyInIshikawa && isShortFastPathCandidate(studentMessage)) {
      const nextState = ensureDefaultCategoriesIfEmpty(safeClone(ishikawaState));

      // Caso 1: confirmación de cerrar rama (rápido) -> liberamos cursor a nivel categoría
      if (isCloseBranchConfirm(studentMessage) && nextState.cursor?.categoryId) {
        const cat = nextState.categories.find((c) => c.id === nextState.cursor?.categoryId);
        const catName = cat?.name ?? "la categoría actual";

        // Dejamos cursor solo en categoría (sin mainCauseId/subCauseId)
        nextState.cursor = { categoryId: nextState.cursor.categoryId };

        return ok({
          assistantMessage:
            `✅ Perfecto, cerramos esa rama como **causa raíz candidata**.\n` +
            `Para completar **${catName}**, dime otra **causa principal** (otra rama) dentro de la misma categoría.`,
          updates: { nextState },
        });
      }

      // Caso 2: respuesta corta a un "¿por qué?" si hay subcausa activa
      const active = findActiveNodes(nextState);
      if (active?.sc) {
        const sc = active.sc;
        const whysArr = (sc.whys ?? []).map((w) => (typeof w === "string" ? w : (w.text ?? ""))).filter(Boolean);

        const answerRaw = studentMessage.trim();

        // 🚫 No es causa (navegación / meta / control)
        if (isNonCausalMessage(answerRaw)) {
          return ok({
            assistantMessage:
              "Perfecto 👍 Antes de cambiar de categoría, terminemos de **cerrar esta causa**. " +
              "Dime **por qué ocurre** este problema en la práctica (una razón concreta que genere el desorden).",
            updates: { nextState },
          });
        }

        // 🚫 Es demasiado vaga
        if (isVagueWhyAnswer(answerRaw)) {
          return ok({
            assistantMessage: buildClarifyWhyMessage(answerRaw),
            updates: { nextState },
          });
        }

        // ✅ Recién aquí es una causa válida
        const answer = normalizeWhyText(answerRaw);
        const alreadyExists = whysArr.some(
          (w) => w.toLowerCase() === answer.toLowerCase()
        );

        if (!alreadyExists) {
          whysArr.push(answer);
        }

        // Guardar de vuelta respetando tipo IshikawaWhy
        sc.whys = whysArr;

        const depth = whysArr.length;
        const max = nextState.maxWhyDepth ?? 3;

        // Si ya llegamos a profundidad, proponemos cerrar
        if (depth >= max) {
          // liberamos subCauseId para permitir otra subcausa en la misma causa principal
          nextState.cursor = { categoryId: active.cat.id, mainCauseId: active.mc.id };

          return ok({
            assistantMessage:
              `Tiene sentido: esto explica la causa a un nivel ya **accionable** (impacta en paros/tiempo muerto y OEE).\n` +
              `✅ Ya llegamos a profundidad suficiente (${depth}). ¿Te parece si **cerramos esta subcausa** como causa raíz candidata y agregamos otra subcausa dentro de **"${active.mc.name ?? active.mc.text ?? "esta causa"}"**?`,
            updates: { nextState },
          });
        }

        // Si aún no llegamos, seguimos preguntando “por qué”
        return ok({
          assistantMessage: buildVariedFollowUp(studentMessage),
          updates: { nextState },
        });
      }

      // Si no hay subcausa activa, NO hacemos fast-path (evitamos “inventar” flujo)
      // Caemos al Gemini normal.
    }

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

    if (intent === "HELP" && alreadyInIshikawa) {
    return ok({
        assistantMessage:
            "📌 Estamos en Ishikawa y **no reiniciamos** la etapa.\n" +
            "¿Quieres que sigamos con la **misma rama** (recomendado) o prefieres cambiar de categoría/causa?",

        updates: { nextState: ishikawaState },
    });
    }

    const problemText =
      typeof ishikawaState.problem === "string"
        ? ishikawaState.problem
        : ishikawaState.problem?.text ?? "";

    const minimalContext = {
      product: caseContext?.product ?? caseContext?.producto ?? null,
      sector: caseContext?.sector ?? caseContext?.rubro ?? null,
      areas: caseContext?.areas ?? caseContext?.area ?? null,
      problem: problemText || null,
      cursor: ishikawaState.cursor ?? null,
    };

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

    Contexto mínimo:
    ${JSON.stringify(minimalContext)}

    Estado Ishikawa (solo lo necesario):
    ${JSON.stringify({
      minMainCausesPerCategory: ishikawaState.minMainCausesPerCategory,
      minSubCausesPerMain: ishikawaState.minSubCausesPerMain,
      maxWhyDepth: ishikawaState.maxWhyDepth,
      cursor: ishikawaState.cursor ?? null,
      categories: (ishikawaState.categories ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        mainCauses: (c.mainCauses ?? []).map((mc) => ({
          id: mc.id,
          name: mc.name ?? mc.text ?? "",
          subCauses: (mc.subCauses ?? []).map((sc) => ({
            id: sc.id,
            name: sc.name ?? sc.text ?? "",
            whysCount: (sc.whys ?? []).length,
          })),
        })),
      })),
    })}
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

    // 2) Enforce mínimo: 1 frase conectada al mensaje del estudiante + 1 pregunta variada
    if (typeof parsed.assistantMessage === "string") {
      let m = parsed.assistantMessage.trim();

      // limpia etiquetas viejas si aparecen
      m = m.replace(/^Análisis:\s*/i, "");
      m = m.replace(/\n?Siguiente pregunta:\s*/i, "\n");

      // Si está vacío/muy corto, o suena a plantilla repetida, lo regeneramos variado
      const looksTemplate =
        /ok,\s*eso encaja/i.test(m) ||
        /p[ée]rdida de eficiencia/i.test(m) && /¿por qu[ée]/i.test(m);

      const tooShort = m.length < 30;

      const hasQuestion = /\?\s*$/.test(m);

      if (tooShort || looksTemplate) {
        parsed.assistantMessage = buildVariedFollowUp(studentMessage);
      } else if (!hasQuestion) {
        // si no termina en pregunta, le añadimos una pregunta variada conectada
        parsed.assistantMessage = `${m}\n${buildVariedFollowUp(studentMessage).split("\n").slice(1).join("\n")}`;
      } else {
        parsed.assistantMessage = m;
      }
    }

    const merged = mergeIshikawaState(ishikawaState, parsed.updates.nextState as IshikawaState);

    return ok({
      assistantMessage: parsed.assistantMessage,
      updates: { nextState: merged },
    });

  } catch (e: any) {
    const requestId = makeRequestId();
    console.error("[ISHIKAWA] INTERNAL", { requestId, error: e });

    return failResponse(
      "INTERNAL",
      `Ocurrió un error interno al procesar Ishikawa. Intenta de nuevo. (ref: ${requestId})`,
      500
    );
  }
}
