// src/lib/plan/ishikawaContextStore.ts

// Datos del caso para los prompts de Ishikawa (E4). Solo servidor.
//
// Se lee todo por el user_id de la sesión (ishikawa/assistant ya verificó que el chat es del
// usuario con assertChatOwner): plan_case_contexts (rubro, productos, áreas) y los artefactos
// validados de E2 (foda_analysis) y E3 (brainstorm_ideas), prefiriendo los del mismo chat. No
// se confía en lo que mande el cliente: al entrar a E4 el cliente ya no tiene la lluvia de
// ideas. Si algo falta o falla, el turno sigue sin ese dato.

import { supabaseServer } from "@/lib/supabaseServer";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

export type IshikawaContextSources = {
  caseContext: unknown;
  foda: unknown;
  brainstorm: unknown;
};

const EMPTY_SOURCES: IshikawaContextSources = { caseContext: null, foda: null, brainstorm: null };

async function loadCaseContext(userId: string): Promise<unknown> {
  const { data, error } = await supabaseServer
    .from("plan_case_contexts")
    .select("context_json")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[ISHIKAWA] lectura del contexto del caso", error);
    return null;
  }

  return data?.context_json ?? null;
}

async function loadValidatedPayload(
  userId: string,
  chatId: string,
  stage: number,
  artifactType: string
): Promise<unknown> {
  const result = await loadLatestValidatedArtifact({
    userId,
    preferredChatId: chatId,
    stage,
    artifactType,
    periodKey: getPeriodKeyLaPaz(),
  });

  if (!result.ok) {
    console.error(`[ISHIKAWA] lectura de ${artifactType}`, result.error);
    return null;
  }

  return result.row?.payload ?? null;
}

export async function loadIshikawaContextSources(
  userId: string,
  chatId: string
): Promise<IshikawaContextSources> {
  try {
    const [caseContext, foda, brainstorm] = await Promise.all([
      loadCaseContext(userId),
      loadValidatedPayload(userId, chatId, 2, "foda_analysis"),
      loadValidatedPayload(userId, chatId, 3, "brainstorm_ideas"),
    ]);

    return { caseContext, foda, brainstorm };
  } catch (error) {
    console.error("[ISHIKAWA] lectura del contexto de los prompts", error);
    return EMPTY_SOURCES;
  }
}
