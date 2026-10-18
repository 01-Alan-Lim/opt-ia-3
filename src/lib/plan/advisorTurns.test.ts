import assert from "node:assert/strict";

import { handleBrainstormStartTurn } from "../../app/chat/_lib/turns/brainstormTurn";
import { handleFodaCloseTurn } from "../../app/chat/_lib/turns/fodaTurn";
import type { AdvisorTurnDeps } from "../../app/chat/_lib/turns/types";

// Caracterización del contrato de los turnos que pueden seguir de largo
// (src/app/chat/_lib/turns): true = el turno quedó atendido y handleSend retorna;
// false = handleSend sigue con las ramas siguientes, igual que antes de la extracción.
// Vive aquí porque el runner solo recorre src/lib/plan.

type Call = [name: string, args: unknown[]];

// Dependencias simuladas: cada referencia es una función que registra la llamada. Una
// dependencia sin implementación falla, así se ve qué usa cada turno.
function fakeDeps(impl: Record<string, (...args: unknown[]) => unknown>) {
  const calls: Call[] = [];
  const group = new Proxy(
    {},
    {
      get: (_target, name) => (...args: unknown[]) => {
        calls.push([String(name), args]);
        const fn = impl[String(name)];
        if (!fn) throw new Error("dependencia no esperada: " + String(name));
        return fn(...args);
      },
    }
  );
  const deps = { state: group, api: group, chat: group, flow: group } as unknown as AdvisorTurnDeps;
  return { deps, calls };
}

const names = (calls: Call[]) => calls.map(([name]) => name);

async function main() {
  // ---------------- E2: cierre del FODA ----------------
  {
    // Sin pedido de avanzar no hace nada y deja seguir a la rama de E2 con IA.
    const { deps, calls } = fakeDeps({});
    assert.equal(await handleFodaCloseTurn(deps, { text: "tengo una duda con las amenazas", advisorChatId: "c1" }), false);
    assert.deepEqual(calls, []);
  }
  {
    // Validación rechazada: muestra el mensaje del servidor y no avanza.
    const { deps, calls } = fakeDeps({
      validateFoda: async () => ({ ok: false, payload: { message: "Faltan amenazas." } }),
      appendAssistant: async () => undefined,
    });
    assert.equal(await handleFodaCloseTurn(deps, { text: "¿qué sigue?", advisorChatId: "c1" }), true);
    assert.deepEqual(calls, [
      ["validateFoda", []],
      ["appendAssistant", ["Faltan amenazas."]],
    ]);
  }
  {
    // Validación aceptada: la transición la decide applyBackendAdvisorAdvance con el payload del servidor.
    const payload = { next: { toStage: 3 } };
    const { deps, calls } = fakeDeps({
      validateFoda: async () => ({ ok: true, payload }),
      applyBackendAdvisorAdvance: async () => true,
    });
    assert.equal(await handleFodaCloseTurn(deps, { text: "continuar", advisorChatId: "c1" }), true);
    assert.deepEqual(calls, [
      ["validateFoda", []],
      ["applyBackendAdvisorAdvance", [{ fromStage: 2, payload, effectiveChatId: "c1" }]],
    ]);
  }
  {
    // Validado pero sin poder preparar E3: avisa y termina el turno.
    const { deps, calls } = fakeDeps({
      validateFoda: async () => ({ ok: true, payload: {} }),
      applyBackendAdvisorAdvance: async () => false,
      appendAssistant: async () => undefined,
    });
    assert.equal(await handleFodaCloseTurn(deps, { text: "pasamos", advisorChatId: "c1" }), true);
    assert.deepEqual(names(calls), ["validateFoda", "applyBackendAdvisorAdvance", "appendAssistant"]);
    assert.match(String(calls[2][1][0]), /^✅ FODA validado, pero no pude preparar automáticamente la Etapa 3\./);
  }

  // ---------------- E3: enganche inicial ----------------
  {
    // Sin mencionar la etapa no hace nada.
    const { deps, calls } = fakeDeps({});
    assert.equal(await handleBrainstormStartTurn(deps, { text: "hola", effectiveChatId: "c1" }), false);
    assert.deepEqual(calls, []);
  }
  {
    // Sin estado guardado: crea el inicial (mínimo de 10 ideas en el cliente) y lo guarda en el chat.
    const { deps, calls } = fakeDeps({
      getBrainstormState: async () => ({ ok: true, payload: { exists: false } }),
      setBrainstormState: () => undefined,
      saveBrainstormState: async () => ({ ok: true }),
      appendAssistant: async () => undefined,
    });
    assert.equal(await handleBrainstormStartTurn(deps, { text: "Empecemos la lluvia de ideas", effectiveChatId: "c1" }), true);
    const initial = { step: "choose_strategy", strategy: null, problem: null, ideas: [], minIdeas: 10 };
    assert.deepEqual(calls.slice(0, 3), [
      ["getBrainstormState", []],
      ["setBrainstormState", [initial]],
      ["saveBrainstormState", [initial, "c1"]],
    ]);
    assert.deepEqual(names(calls.slice(3)), ["appendAssistant"]);
  }
  {
    // Existe pero sin un estado legible: no atiende el turno y handleSend sigue.
    const { deps, calls } = fakeDeps({
      getBrainstormState: async () => ({ ok: true, payload: { exists: true, state: null } }),
    });
    assert.equal(await handleBrainstormStartTurn(deps, { text: "etapa 3", effectiveChatId: "c1" }), false);
    assert.deepEqual(names(calls), ["getBrainstormState"]);
  }
}

main()
  .then(() => console.log("advisorTurns tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
