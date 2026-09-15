# OPT-IA — Reglas de trabajo

## Contexto
Plataforma académica para estudiantes y docentes de Ingeniería Industrial.
Acompaña la elaboración del Plan de Mejora PAP-PM-01 en 11 etapas (E0-E10).
Enfoque Human-in-the-Loop: OPT-IA orienta, NO sustituye el juicio del
estudiante ni del docente.

## Stack vigente
Next.js App Router 16 · React 19 · TypeScript estricto · Tailwind 4 · Zod 4
Supabase (Auth + Postgres + Storage + RLS) · Google Gemini · pgvector · Vercel

Autenticación: Supabase Auth + Google OAuth.
Privy está DESCARTADO. No reintroducir. Referencias residuales = legacy.

## Reglas no negociables

### Seguridad
- Nunca confiar en userId enviado por el cliente. Resolver identidad
  server-side vía Supabase y reforzar con RLS.
- Validar rol, ownership y cohorte server-side.
- NUNCA abrir, leer ni mostrar .env, .env.local ni secretos. Los nombres de
  variables sí, los valores nunca.
- Si aparecen secretos versionados: detenerse, reportar sin reproducir el
  valor, recomendar rotación.
- No exponer nombres reales de empresas o personas en outputs de IA.

### Desarrollo
- TypeScript estricto. Prohibido @ts-ignore. Evitar any.
- APIs validadas con Zod.
- Errores consistentes: { ok: false, code, message }
- No inventar archivos, endpoints, tablas, columnas ni policies.
  Verificar contra el código real y Supabase real.

### Git
- Revisar rama y git status antes de cualquier cambio.
- Nunca trabajar directamente sobre main.
- No hacer commit, push, deploy ni migraciones sin autorización explícita.
- Cambios pequeños en ramas separadas. No mezclar auditoría con refactor.

### Jerarquía de verdad
Repositorio real > Supabase real > Vercel > Git/GitHub > documentación.
Los documentos históricos NO son fuente final de verdad.

## Decisiones metodológicas (autoridad: el usuario)

### Ishikawa (E4)
- Mínimo 10 causas raíz para cerrar la etapa. NO bajar este número.
- La profundidad de porqués es variable: algunos casos cierran en 3,
  otros necesitan hasta 5. El cierre debe ser por CALIDAD (la causa es
  accionable), no por contador.
- El flujo debe ser conversacional: preguntar, analizar la respuesta,
  decidir si se llegó a la raíz o se sigue profundizando.

### Pareto (E5)
- Recibe las causas raíz que produzca Ishikawa. Sin mínimo propio.
- El corte 20/80 NO es rígido. Puede ser 30/70, 25/75, 10/90.
  Lo que importa es evidenciar que un grupo minoritario de causas
  concentra la mayoría del problema, y que el estudiante lo justifique.

### Transversal
- En cualquier etapa, el estudiante debe poder preguntar "¿qué me falta?"
  o "¿por qué no puedo avanzar?" y recibir una respuesta concreta y
  accionable, no genérica.

## Estado del trabajo

### Completado — Tanda 1 (commit 7e92d36, rama fix/advisor-unblock-e4-e5, sin push)
- Ishikawa exige 10 causas raíz. Constante compartida en rootCauseLimits.ts.
- Pareto sin mínimo ni tope propio: recibe todas las raíces de Ishikawa.
- Corte 20% fijo reemplazado por evaluateParetoCut (paretoCut.ts):
  minoría de causas (<50%), mayoría del efecto (>50%), desbalance >=20 puntos.
  El estudiante declara el % desde su Excel.
- select_roots es paso de revisión explícito: el estudiante lee sus causas
  y responde OK.
- "no se controla/revisa/verifica" ya no se clasifica como pedido de ayuda.

### Completado — Tanda 2: profundidad variable de porqués en Ishikawa (misma rama, sin push)
- Paso A (2b024bb): whyQuality.ts. Filtro determinista barato (tautología,
  causa solo externa, generalidad) + juicio de accionabilidad del LLM +
  decideWhyStep. Profundidad 3-5 (MIN_WHY_DEPTH / MAX_WHY_DEPTH en
  rootCauseLimits.ts). Sin veredicto accionable explícito nunca se cierra.
- Paso B (3ebbd8f): whyList.ts. Tope de 5; en el tope sin causa accionable se
  pide reformular el último porqué (whysReplace: la lista es autoritativa al
  guardar). Gate de calidad en la ruta rápida.
- Paso C (commit posterior a 3ebbd8f): todo cierre de rama pasa por el gate y los
  campos de cierre son de autoridad del servidor.
  - closure = { reviewed, at, verdict: "actionable", origin: "student_confirm" |
    "system", rootId } en la subcausa (ishikawaTree.ts, Zod). Solo lo escribe el
    servidor tras el gate.
  - closure, rejectedWhyAttempts, reformulateWhy, rootCauses y pendingRootMatch:
    ishikawa/assistant los lee de la base (no del cuerpo) y los escribe en
    plan_stage_states ANTES de responder; el guardado del cliente (ishikawa/state)
    los descarta y conserva los almacenados (ishikawaStateMerge.ts,
    ishikawaStateStore.ts). El asistente exige chatId y verifica la propiedad del
    chat en el servidor (lib/auth/chatOwner.ts). ishikawa/state valida con Zod.
  - Confirmación del estudiante ("cerremos", "ok, cerrar"): solo si el mensaje
    entero es la confirmación (isCloseBranchConfirm) y pasa por el gate.
  - El LLM no escribe campos del servidor ni cierra soltando el cursor: se valida
    con el gate y, si no pasa, el cursor vuelve a la subcausa (ishikawaBranchFlow.ts).
  - Moverse a otra rama no se bloquea; la rama queda sin closure y no cuenta.
  - Registro de causas raíz (state.rootCauses, ishikawaRootRegistry.ts): una raíz
    repetida en varias ramas cuenta UNA vez. Coincidencia normalizada exacta → se
    informa; parecida → una consulta a Gemini y, si propone, se PREGUNTA al
    estudiante (decide él; mientras tanto no se ofrece Pareto ni valida E4). El
    mínimo de 10 se cuenta sobre el registro (ishikawaRoots.ts, REQUIRE_REVIEWED_CLOSURE).
    validate guarda rootOccurrences en el payload; E5 no cambió.
  - La profundidad y el cierre se deciden sobre la lista de porqués guardada, nunca
    sobre la filtrada por sanitizeWhyList (keepStoredWhys en el camino general).
  - Estados sin closure ni registro (los planes reales de antes) cuentan 0 raíces:
    hay que volver a cerrar esas ramas. Decisión: no se migran.
  - El servidor envía ui = { branchJustClosed, offerStageClose, awaitingWhy,
    awaitingRootMatch }; el cliente no lee el texto del mensaje.
  - validate respondía {} en sus rechazos (NextResponse.json(ok(...))): corregido.
  - Pruebas: npm test (arnés con Gemini simulado).

### Pendiente — Tanda 3: "¿qué me falta?" transversal
Que en cualquiera de las 11 etapas el estudiante pueda preguntar qué le falta
o por qué no puede avanzar, y reciba respuesta concreta. Las reglas de cierre
de cada etapa ya son deterministas y están mapeadas.

### Deuda técnica conocida (no tocada)
- conversationIntent.ts clasifica mal "no se..." en Pareto; también atrapa
  "no seleccione". Peor que el caso de Ishikawa.
- Otras frases pasivas en Ishikawa siguen mal clasificadas: "no se capacita",
  "no se registra", "no se supervisa", "no se cumple".
- parseCriteriaFromMessage se llama dos veces por turno en pareto/assistant.
- /api/chat envía los 12 PRIMEROS mensajes del historial, no los últimos
  (chat/route.ts:630, order asc). El agente pierde contexto reciente.
- foda/validate guarda el artefacto y avanza ANTES de evaluar; si el JSON del
  LLM falla, responde 500 con la DB ya en E3 y el frontend en E2.
- Sin middleware.ts: las páginas no tienen protección server-side.
- Hasta 4-5 llamadas secuenciales a Gemini por turno.
- Siguiente tramo: autoridad total del turno de E4. Hoy el árbol y los porqués
  siguen viniendo del cliente; solo closure, contadores, registro de raíces y la
  pregunta pendiente son del servidor.
- La entrada de respuestas nuevas exige frase causal (sanitizeWhyCandidate): "El
  operario no conoce el procedimiento" cae en la aclaración y no se guarda por la
  ruta rápida. En el camino general, los porqués que agrega el LLM sin frase
  causal se descartan (keepStoredWhys).
- Prompt general de Ishikawa: product y areas llegan siempre null (E0 guarda
  products / process_focus como listas); brainstormState se recibe y no se usa.
- Retomar una rama a medias: listar las pendientes ya es determinista
  (deriveRootCauses().pendingBranches), pero mover el cursor a una subcausa
  concreta depende del LLM, y nada recuerda al estudiante que una rama esperaba
  una reformulación.
- whysCount (dato del prompt) quedó guardado en 237 de 251 subcausas reales: el
  LLM lo copia en su nextState.
- Sin bloqueo optimista en plan_stage_states: dos turnos simultáneos del mismo
  chat (dos pestañas) → gana el último (updated_at tiene trigger y permitiría
  agregarlo sin migración).
- distinctFrom es por id: si una raíz sale del registro (rama reabierta sin otras
  ramas), se pierde la marca de "distintas" y ese par puede volver a preguntarse.
- Con una pregunta de raíz repetida pendiente, cualquier otro mensaje recibe el
  recordatorio: el estudiante no puede seguir con otra rama hasta responder sí/no.

## Pendientes de seguridad (NO tocar sin autorización)
- 7 views BI son SECURITY DEFINER y anon tiene SELECT: fuga de datos de
  estudiantes con la anon key pública.
- profiles_update_own no restringe columnas: un estudiante puede ponerse
  role='teacher' y activar las policies IS_TEACHER de RLS.
