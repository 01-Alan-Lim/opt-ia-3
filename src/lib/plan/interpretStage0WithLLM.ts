import { getGeminiModel } from "@/lib/geminiClient";

export type Stage0LLMResult = {
  intent:
    | "ANSWER_VALID"
    | "ANSWER_INVALID"
    | "ASK_CHANGE"
    | "GREETING"
    | "CONFIRM"
    | "OTHER";
  confidence: number;
  extracted?: {
    sector?: string;
    products?: string[];
    process_focus?: string[];
  };
  reply?: string; // sugerencia humana opcional
};

export async function interpretStage0WithLLM(
  step: 1 | 2 | 3,
  userText: string,
  contextJson: any
): Promise<Stage0LLMResult> {
  const model = getGeminiModel();

  const questionMap = {
    1: "sector o rubro de la empresa",
    2: "producto(s) o servicio(s) principal(es)",
    3: "área o proceso principal donde trabajará",
  };

  const expected = questionMap[step];

  const prompt = `
Eres un asistente académico que ayuda a estudiantes a registrar el CONTEXTO DEL CASO.

Pregunta actual (${step}/3):
"${expected}"

Respuesta del estudiante:
"${userText}"

Contexto ya registrado:
${JSON.stringify(contextJson, null, 2)}

Tareas:
1. Determina si la respuesta REALMENTE responde a la pregunta actual.
2. Si el estudiante quiere cambiar algo anterior, detecta eso.
3. Si es un saludo, confusión o confirmación, clasifícalo.

Devuelve SOLO JSON válido con esta forma:

{
  "intent": "ANSWER_VALID | ANSWER_INVALID | ASK_CHANGE | GREETING | CONFIRM | OTHER",
  "confidence": 0.0,
  "extracted": {
    // SOLO si aplica al step:
    // step 1: { "sector": string }
    // step 2: { "products": string[] }
    // step 3: { "process_focus": string[] }
  },
  "reply": "opcional, tono humano"
}
`;

  const res = await model.generateContent(prompt);
  const text = res.response.text();

  try {
    return JSON.parse(text) as Stage0LLMResult;
  } catch {
    return {
      intent: "OTHER",
      confidence: 0,
      reply: "Perdón, ¿puedes reformular tu respuesta?",
    };
  }
}
