import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  historySpeaker,
  isAdvisorSideRole,
  LOCAL_GUIDE_PREFIX,
  MESSAGE_ROLES,
  serverHistorySpeaker,
  toIshikawaRecentMessage,
} from "../chat/messageProvenance";
import { createMessage } from "../chat/assistantFormat";
import { lastAssistantIsStage0Prompt } from "./stage0Context";

// Procedencia de los mensajes (R1): user (estudiante), assistant (emitido por el servidor) y
// advisor (texto local del asesor). Los textos locales se ven como mensajes del asesor, cuentan
// como "último mensaje del asesor" en la lógica del flujo, pero nunca se presentan al modelo
// como respuestas del asistente ni como instrucciones de sistema.

function main() {
  assert.deepEqual([...MESSAGE_ROLES], ["user", "assistant", "advisor"], "system no es un rol válido");

  // Lado de la conversación.
  assert.equal(isAdvisorSideRole("assistant"), true);
  assert.equal(isAdvisorSideRole("advisor"), true);
  assert.equal(isAdvisorSideRole("user"), false);
  assert.equal(isAdvisorSideRole("system"), false);

  // Historial que manda el navegador a las rutas assistant.
  assert.equal(historySpeaker("user"), "STUDENT");
  assert.equal(historySpeaker("assistant"), "ASSISTANT");
  assert.equal(historySpeaker("advisor"), "PLATFORM_GUIDE");

  // Ishikawa: la ruta solo admite user/assistant; el texto local va marcado.
  assert.deepEqual(toIshikawaRecentMessage({ role: "user", content: "Falta mantenimiento" }), {
    role: "user",
    content: "Falta mantenimiento",
  });
  assert.deepEqual(toIshikawaRecentMessage({ role: "assistant", content: "¿Por qué ocurre?" }), {
    role: "assistant",
    content: "¿Por qué ocurre?",
  });
  assert.deepEqual(toIshikawaRecentMessage({ role: "advisor", content: "Ya tenemos una base suficiente." }), {
    role: "assistant",
    content: LOCAL_GUIDE_PREFIX + "Ya tenemos una base suficiente.",
  });

  // Historial que /api/chat arma desde la base.
  assert.equal(serverHistorySpeaker("user"), "Usuario");
  assert.equal(serverHistorySpeaker("assistant"), "Asistente");
  assert.equal(serverHistorySpeaker("advisor"), "Guía automática (no IA)");
  assert.equal(serverHistorySpeaker("otro"), "Guía automática (no IA)", "nada desconocido pasa por asistente");

  // E0: las preguntas del asistente de contexto son textos locales (advisor) y siguen contando.
  const prompt = "**1/3** ¿Cuál es el sector o rubro de la empresa?";
  assert.equal(lastAssistantIsStage0Prompt([createMessage("advisor", prompt)]), true);
  assert.equal(lastAssistantIsStage0Prompt([createMessage("assistant", prompt)]), true, "histórico");
  assert.equal(lastAssistantIsStage0Prompt([createMessage("advisor", prompt), createMessage("user", "Panadería")]), true);
  assert.equal(
    lastAssistantIsStage0Prompt([createMessage("advisor", prompt), createMessage("assistant", "Listo, sigamos.")]),
    false,
  );
  assert.equal(lastAssistantIsStage0Prompt([createMessage("user", prompt)]), false);

  // Código: los constructores de historial usan la política y no hay instrucciones SYSTEM.
  const read = (...p: string[]) => readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n");
  const page = read("src", "app", "chat", "page.tsx");
  assert.ok(page.includes(".map((m) => `${historySpeaker(m.role)}: ${m.content}`)"));
  assert.ok(page.includes(".map(toIshikawaRecentMessage);"));
  assert.ok(!page.includes('"SYSTEM:'), "el navegador no arma instrucciones de sistema");
  assert.ok(!/m\.role === "assistant"/.test(page), "page.tsx distingue el lado del asesor con la política");
  assert.ok(read("src", "app", "api", "chat", "route.ts").includes("${serverHistorySpeaker(m.role)}: ${m.content}"));
  assert.ok(!read("src", "lib", "types.ts").includes('"system"'));
}

main();
console.log("messageProvenance tests passed");
