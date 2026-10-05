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

Las ramas de las tandas completadas (abajo) están publicadas en origin y NINGUNA está mergeada
a main (origin/main no contiene 7e92d36 ni lo posterior).

### Completado — Tanda 1 (commit 7e92d36, rama fix/advisor-unblock-e4-e5)
- Ishikawa exige 10 causas raíz. Constante compartida en rootCauseLimits.ts.
- Pareto sin mínimo ni tope propio: recibe todas las raíces de Ishikawa.
- Corte 20% fijo reemplazado por evaluateParetoCut (paretoCut.ts):
  minoría de causas (<50%), mayoría del efecto (>50%), desbalance >=20 puntos.
  El estudiante declara el % desde su Excel.
- select_roots es paso de revisión explícito: el estudiante lee sus causas
  y responde OK.
- "no se controla/revisa/verifica" ya no se clasifica como pedido de ayuda.

### Completado — Tanda 2: profundidad variable de porqués en Ishikawa (misma rama)
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

### Completado — Conversación y desbloqueo de E4 (rama feat/advisor-conversation-e4)
- Entrada de respuestas (ishikawaWhyInterpreter.ts), dos juicios separados. ¿Es un
  intento de responder? Permisivo: si no pide ayuda o un ejemplo, no navega (categoría,
  rama o etapa), no pregunta por el proceso y no es un acuse ("ok"), ES una respuesta; no
  se exige frase causal. ¿Sirve como causa? Lo decide whyQuality.ts, con pista. Mismo
  criterio en la ruta rápida y para los porqués que agrega el LLM (keepStoredWhysWithReport).
  Con una subcausa abierta, toda respuesta se captura por la ruta determinista (corta o
  larga) sin el clasificador de intención por IA.
- "no se registra/capacita…" ya no es pedido de ayuda (solo "no sé", "no se qué/cómo…");
  "por ejemplo…", "cerramos la caja…", "pasamos mucho tiempo…", "el mapa de procesos…" ya
  no se toman como ejemplo, cierre, consulta o avance.
- En el tope, tras REJECTED_WHY_ATTEMPTS_LIMIT reformulaciones sin causa accionable se
  escala a formulaciones concretas (no queda en bucle).
- Contexto de los prompts (ishikawaPromptContext.ts, ishikawaContextStore.ts): el
  servidor lee plan_case_contexts (sector; products y process_focus son listas) y los
  artefactos validados de E2 (foda_analysis) y E3 (brainstorm_ideas) por el usuario de la
  sesión, y los resume; no confía en el cliente (brainstormState ya no se recibe). El
  mensaje guiado y las hipótesis reciben problema, rubro, productos, áreas, la cadena
  guardada y los rechazos de la rama. Las instrucciones de coherencia solo nombran lo que
  el prompt recibe.
- Ramas a medias (ishikawaResume.ts): lista determinista y numerada de ramas sin revisar;
  "retomar 2" o "retomar <subcausa>" mueve el cursor sin IA. Se ofrecen al cerrar una
  rama, en el avance, en "pasemos a Pareto" y en validate. Una rama en el tope con
  reformulateWhy pide reformular, no un sexto porqué.
- La pregunta de raíz repetida ya no traba: se muestra al final de cada respuesta hasta
  que se conteste, y solo la responde un sí/no explícito o una frase sobre "la
  misma/distintas". Mientras está abierta, otra raíz parecida queda diferida (recheck) y
  se compara al responder.
- Comienzo del turno determinista (ishikawaTurnRouter.ts): pregunta pendiente, retomar,
  avance / "¿qué me falta?", pasar de etapa, cierre, acuse con la rama abierta, captura.
- Disponibilidad para cerrar E4 compartida (ishikawaReadiness.ts): validate, el mapa, la
  respuesta a "pasemos a Pareto" y el cliente usan las mismas reglas.
- Pruebas: npm test (15 archivos); ishikawaE4Simulation.test.ts recorre E4 entera con
  Gemini simulado. npm test corre scripts/run-tests.mjs (lista de archivos ahí): en
  Windows, una cadena "tsx a && tsx b && …" de 15 archivos en package.json colgaba el
  cmd.exe con que npm ejecuta el script.

### Completado — Tanda de seguridad (rama fix/security-authority-fields-rls)
Código en 9ded60c; migraciones en 8acf582, aplicadas el 2026-10-04 (ver "Seguridad Supabase").
Precedida de un diagnóstico de solo lectura de E0-E10. Hallazgo de fondo: los gates de
cada etapa se podían saltar por código (no por RLS) y la nota final la ponía el cliente.

- /api/plans/stage-state corría con service role y escribía el objeto del cliente tal cual
  para las etapas 0-5 (el `default` de mergeStageState): por ahí se escribía el estado de
  E4 sin pasar por ishikawa/state, que es quien descarta closure, rootCauses y
  pendingRootMatch. Ahora el endpoint genérico solo acepta las etapas que el cliente guarda
  por ahí (6-10); 0-5 se rechazan con STAGE_NOT_ALLOWED nombrando su ruta propia
  (stageAuthority.ts). No se duplicó lógica: cada ruta propia sigue siendo la única puerta
  de su etapa, y E4 sigue usando ishikawaStateMerge.
- DELETE de /api/plans/stage-state: restringido a 2-9, que son las que el cliente limpia al
  avanzar. Decisión: NO se borra el artefacto validado junto con el estado. Borrar el
  estado es el paso normal al cerrar una etapa, el artefacto es la fuente de verdad de las
  siguientes (pareto lee ishikawa_final, objectives lee pareto_final…) y el upsert no
  guarda historial: cascadear destruiría trabajo validado sin vuelta atrás. E10 queda fuera
  del borrado porque guarda la evaluación del servidor.
- E10: evaluation y versionNumber pasan a ser autoridad del servidor. final_doc/assistant
  los escribe en plan_stage_states antes de responder (finalDocStore.ts) y el guardado del
  cliente los descarta (stageAuthority.withStoredFinalDocAuthority, usado por
  stageState.ts). versionNumber ya no se acepta del cuerpo: se deriva de los artefactos
  guardados (v1 si no hay final_doc_v1, si no v2) porque mandar 2 cerraba la etapa sin
  importar la nota. Si ya hay final_doc_final, el assistant responde 409.
- E3: minIdeas sale de MIN_BRAINSTORM_IDEAS (brainstormFlow.ts), nunca del estado. Antes
  venía del cliente acotado a [3,20], así que el mínimo de 10 causas se bajaba a 3.
- src/proxy.ts (convención de Next 16; antes middleware.ts): 404 en /dev/* cuando
  NODE_ENV === "production". La página /dev/index-pdf no tenía guarda; las rutas /api/dev/*
  sí la tienen y el matcher excluye /api. El resto de la Fase 3 quedó BLOQUEADO, ver abajo.
- Pruebas: stageAuthority.test.ts (npm test, 16 archivos).

### Completado — Refactor de src/app/chat/page.tsx (rama refactor/chat-page-architecture, 265832d..9048927)
Solo se movió código, sin cambiar comportamiento; cada tanda se verificó con equivalencia de AST
y pruebas de mutación. page.tsx pasó de 7906 a ~2728 líneas; handleSend de 1273 a ~333 y ahora
es un dispatcher (decide la rama y llama al turno).
- src/app/chat/_lib/:
  - useChatSession.ts: sesión de Supabase Auth y header Bearer. No autoriza.
  - useAccessGate.ts: aplica la respuesta de /api/me (redirecciones, solo lectura).
  - useChatHistory.ts: carga del historial y persistencia en sessionStorage.
  - useAdvisorStages.ts: estado E0-E10 y effects de carga y autoguardado.
  - advisorTransitions.ts: modelo Ishikawa DEL CHAT (no unificado con ishikawaTree.ts) y
    createAdvisorTransitions(deps): restauración y avance E2-E10 según next.toStage del servidor.
  - advisorApi.ts: transporte HTTP; recibe los headers ya resueltos.
  - turns/: un handler por etapa E1-E9 y el contrato AdvisorTurnDeps (turns/types.ts). E3 inicio
    y el cierre de E2 devuelven true/false (true = turno atendido).
- Componentes extraídos: src/components/chat/ChatGateScreen, ChatHeader y ModeSelector.
- Módulos puros: lib/plan/advisorClientIntent, stage0Context, advisorStates y advisorMessages;
  lib/chat/assistantFormat y chatStorage.
- Siguen en page.tsx: bootstrap del asesor, E0 (handleStage0DraftFlowV2), Ishikawa residual,
  ensure/adopt del chat, wrappers con closure, handleNewChat, handleLogout,
  handleUploadPlanFile (E10) y el JSX.
- E1→E2 sigue fijado por el cliente (turns/productivityTurn.ts): decisión vigente.
- Pruebas: npm test, 23 archivos (lista en scripts/run-tests.mjs).

### Siguiente prioridad — Panel docente nativo (rama feat/docente-native-dashboard, desde 9048927)
Las pruebas funcionales reales E0-E10 van DESPUÉS del panel docente. Los bugs funcionales
conocidos (ver deuda) no se corrigen dentro del panel.

### Pendiente — Tanda 3: "¿qué me falta?" transversal
Que en cualquiera de las 11 etapas el estudiante pueda preguntar qué le falta
o por qué no puede avanzar, y reciba respuesta concreta. Las reglas de cierre
de cada etapa ya son deterministas y están mapeadas. (E4 ya lo responde con el mapa
y las reglas de validate.)

### Deuda técnica conocida (no tocada)
- BLOQUEADO — el resto de src/proxy.ts (sesión en /chat, /hours, /onboarding y rol
  docente en /docente). No se puede hoy: la sesión de Supabase vive en localStorage
  (createClient de @supabase/supabase-js, sin @supabase/ssr) y las APIs autentican con
  Authorization: Bearer. La petición de navegación no lleva credencial, así que un gate de
  sesión en el proxy redirigiría al 100% de los usuarios con sesión válida.
  Prerrequisito: mover la sesión a cookies con @supabase/ssr (createServerClient).
- E2: pendingEvidence es autoridad de facto y NO está protegido. foda/validate:152 rechaza
  si está puesto, pero el campo lo manda el cliente (FodaStateSchema en foda/state) y
  borrarlo salta el gate de evidencia. Protegerlo exige que foda/assistant lo escriba en la
  base, como hace ishikawa/assistant con los suyos. El mínimo de 3 por cuadrante sigue.
- /api/companies y /api/method-experiences usan el cliente ANON dentro del servidor
  (companies/route.ts:8 y :56, method-experiences/route.ts:8). companies_select_teacher
  exige authenticated + role teacher, y el cliente anon no lleva sesión: esas rutas
  devuelven CERO filas hoy. Además ningún componente las llama: son endpoints muertos.
  Probablemente rotos en silencio desde fix/rls-companies-method-experiences.
- Las tres rutas /api/dev/index-* también importan el cliente anon. Sí tienen guarda de
  producción (NODE_ENV === "production" -> FORBIDDEN_IN_PRODUCTION).
- conversationIntent.ts clasifica mal "no se..." en Pareto; también atrapa
  "no seleccione". Peor que el caso de Ishikawa.
- parseCriteriaFromMessage se llama dos veces por turno en pareto/assistant.
- /api/chat envía los 12 PRIMEROS mensajes del historial, no los últimos
  (chat/route.ts:630, order asc). El agente pierde contexto reciente.
- foda/validate guarda el artefacto y avanza ANTES de evaluar; si el JSON del
  LLM falla, responde 500 con la DB ya en E3 y el frontend en E2.
- Fuera de /dev/*, las páginas no tienen protección server-side (ver BLOQUEADO arriba).
- E10 trabaja por mes: final_doc/assistant y final_doc/validate filtran por period_key
  (YYYY-MM, America/La_Paz) la línea de tiempo de E2-E9, el final_doc_final y la versión.
  Un plan que cruza de mes no ve en E10 lo validado antes. Además PERIOD_KEY es una const
  de módulo en 18 rutas de api/plans/: se fija al cargar el módulo, no por petición.
- Orden y gates entre algunas etapas requieren revisión funcional (además del caso E2).
- Chat, bugs funcionales verificados al cerrar el refactor (no corregidos):
  - E0: una pregunta ("¿Qué es un sector?") se guarda en el borrador como "?" (normalizeText
    quita el signo); "Fabricamos/Vendemos/Ofrecemos…" extrae "Mos …" como producto; "no estoy
    seguro del sector" guarda "Del Sector"; "área" con tilde no se limpia;
    lastAssistantIsStage0Prompt no reconoce las preguntas actuales (pueden repetirse).
  - Historial (useChatHistory): sin guarda de respuesta vieja al cambiar de chat; un chat vacío
    conserva los mensajes anteriores; messagesRef/chatIdRef se actualizan en effects.
  - Auth (useAccessGate): en un 403 compiten dos redirecciones; el gate no se reevalúa si la
    cuenta cambia sin pasar por "sin sesión".
  - Transiciones: E5 restaurado con estado inválido queda sin estado (cae en /api/plans/review);
    E3 se restaura saneado o no según el camino; clearAdvisorStageStatesLocal no limpia
    prodStep, prodDraft, stage0Draft, editingField ni brainstormClosePending; mínimos iniciales
    de Ishikawa 3/2/1 frente al comentario 4-5/2-3/2-3.
  - E4: validateIshikawa usa el chatId del render (puede ser viejo).
  - Tipos duplicados: ChatRouter (useAccessGate.ts y useChatHistory.ts); ChatMode (page.tsx y
    Sidebar.tsx).
- Dashboard docente: solo incrusta el informe de Looker Studio en un iframe
  (components/teacher/TeacherDashboard.tsx); falta un dashboard nativo.
- Hasta 4-5 llamadas secuenciales a Gemini por turno.
- Siguiente tramo: autoridad total del turno de E4. Hoy el árbol y los porqués
  siguen viniendo del cliente; solo closure, contadores, registro de raíces y la
  pregunta pendiente son del servidor.
- E4, entrada permisiva: un mensaje que no es ayuda, navegación ni consulta y no está en
  las listas (p. ej. "eso ya lo sabemos") se guarda como porqué si pasa la calidad, y no
  hay forma de borrar un porqué desde el chat.
- E4: ayuda, navegación, avance y consultas se reconocen por listas de frases; un falso
  positivo no se guarda como respuesta. Sin una subcausa abierta siguen
  isNonCausalMessage / looksLikeSwitchCategoryIntent ("vamos a", "ahora con").
- E4: el clasificador contextual por IA se sigue llamando si el mensaje trae palabras de
  navegación (categoría, rama, sigamos…); solo puede sumar navegación.
- E4: la regla de nombres propios es una instrucción a Gemini; el FODA y la lluvia de
  ideas llegan como texto del estudiante y no se filtran.
- E4: "cambiemos de rama" pregunta la categoría; no ofrece la lista de ramas sin terminar.
- ishikawa/assistant sigue siendo grande (~2800 líneas); el arnés simula el despacho con
  las funciones puras, no la redacción de mensajes ni el HTTP.
- whysCount (dato del prompt) quedó guardado en 237 de 251 subcausas reales: el
  LLM lo copia en su nextState.
- Sin bloqueo optimista en plan_stage_states: dos turnos simultáneos del mismo
  chat (dos pestañas) → gana el último (updated_at tiene trigger y permitiría
  agregarlo sin migración).
- distinctFrom es por id: si una raíz sale del registro (rama reabierta sin otras
  ramas), se pierde la marca de "distintas" y ese par puede volver a preguntarse.
- Con una pregunta de raíz repetida abierta, un "sí"/"no" suelto siempre la responde a
  ella, aunque el último mensaje del asistente preguntara otra cosa.

## Seguridad Supabase (aplicada y verificada el 2026-10-04)
Proyecto luvcduxkasaeyobdyafj. Cualquier cambio nuevo de esquema, RLS o grants sigue
necesitando autorización explícita de Alan. apply_migration asigna una versión nueva: después
de aplicar, renombrar el archivo local a esa versión (git mv, contenido intacto). Hoy los
filenames de supabase/migrations/ coinciden con el historial remoto.

| Versión remota | Migración | Qué cierra |
|---|---|---|
| 20261004170835 | profiles_update_own_column_scope | authenticated sin INSERT/UPDATE en profiles (tampoco por columna) y sin profiles_insert_own: ya no se puede poner role='teacher' ni aprobarse |
| 20261004195245 | plan_tables_readonly_for_authenticated | sin INSERT/UPDATE del cliente en plan_stage_artifacts, plan_stage_states y plan_case_contexts; queda SELECT propio |
| 20261004200351 | plan_stage_evaluations_no_client_insert | sin INSERT del cliente en plan_stage_evaluations; queda SELECT propio |
| 20261004200840 | bi_views_revoke_anon | 7 views BI sin privilegios para anon ni authenticated. SECURITY DEFINER y el SELECT de looker_reader se conservan a propósito (sin ellos Looker queda en blanco) |
| 20261004200939 | revoke_broad_anon_grants | anon sin privilegios en ninguna relación de public |
| 20261004201031 | hours_insert_student_authenticated | hours_insert_student `to authenticated` (antes `to public`), mismo WITH CHECK |

Toda escritura de esas tablas pasa por rutas de API con service role (src/lib/supabaseServer.ts).
Las 18 tablas de public tienen RLS activa.

### Deuda de seguridad y rendimiento (no tocada)
- authenticated conserva grants de tabla amplios (arwdDxtm) en cohort_events, cohorts,
  hours_entries, plan_* y user_google_calendar_*; en profiles, rdDxtm. La RLS impide escribir
  donde no hay policy, pero el grant incluye TRUNCATE, que la RLS no cubre (PostgREST no lo
  expone).
- public.set_updated_at sin search_path fijo (advisor function_search_path_mutable).
- Auth: leaked password protection deshabilitado (poco relevante: el acceso es Google OAuth).
- Advisors de rendimiento: 40 auth_rls_initplan (auth.uid() sin `(select ...)`),
  4 multiple_permissive_policies (cohort_events, cohorts, hours_entries, profiles),
  4 pares de índices duplicados, 5 foreign keys sin índice, 15 índices sin uso.
