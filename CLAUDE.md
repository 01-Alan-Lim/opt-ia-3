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

### Estilo conversacional del asesor (E0-E10)
Pautas en src/lib/chat/advisorVoice.ts. Hoy las aplica solo E0; E1-E10 las adoptan cuando se
revisen (sin refactor por ahora).
- Mentor académico: natural, cercano y profesional. Orienta; el estudiante decide.
- Una sola pregunta principal por turno, en negrita y en su propio párrafo, sin repetirla.
- Reconocer lo que el estudiante ya respondió antes de pedir lo siguiente.
- Emojis solo cuando aportan claridad; sin felicitaciones automáticas ("Perfecto 👍").
- No inventar hechos de la empresa.
- No inferir el género por nombre, foto o correo; expresiones neutras ("te doy la bienvenida",
  "la persona que te supervisa"). No hay columna de género ni se agrega.
- Nombre: saludar por el nombre de pila del perfil al abrir la etapa; "Univ." solo en la cabecera
  del chat, solo para estudiantes, nunca en las respuestas.
- Formato: el Markdown que ya pinta MessageList (### para la etapa, **negrita** para la pregunta),
  sin HTML; el texto debe quedar igual tras formatAdvisorReplyForChat.
- Terminología (decisión de Alan): "Práctica Empresarial", en singular, para la asignatura y la
  experiencia de cada estudiante ("durante tu Práctica Empresarial", "la empresa donde realizas tu
  práctica", "el proceso que estás analizando", "las actividades que desarrollas en la empresa").
  No "Prácticas Empresariales" para la de un estudiante, ni "pasantía" o "prácticas profesionales"
  como sinónimos, ni repetirla en cada mensaje. No suponer que el estudiante es empleado de la
  empresa; los términos técnicos ("puesto de trabajo", "métodos de trabajo", "condiciones de
  trabajo", "carga de trabajo") sí valen. Nunca nombres reales de empresas.
- Asistente General: su saludo (generalAssistantGreeting en advisorVoice.ts) usa el mismo nombre de
  pila; solo vive en pantalla y en sessionStorage (/api/chat no lo recibe ni lo guarda).
- Pendiente en E1-E10: saludan con getPreferredStudentFirstName (primera palabra de first_name,
  sin formato: "ALAN" queda "ALAN"), sus textos tienen muletillas como "Perfecto 👍" y todavía no
  aplican la terminología.

## Estado del trabajo

Las tandas anteriores ya están en origin/main (contiene 7e92d36 y 9048927). E0 (commit 4018a5e)
y la Biblioteca Académica (rama feat/academic-library, desde 4018a5e) son locales, sin push: se
publican juntos, directo en Production.

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
- Siguen en page.tsx: bootstrap del asesor, Ishikawa residual, ensure/adopt del chat, wrappers
  con closure, handleNewChat, handleLogout, handleUploadPlanFile (E10) y el JSX. E0
  (handleStage0DraftFlowV2) salió después a turns/stage0Turn.ts (ver E0 conversacional).
- E1→E2 sigue fijado por el cliente (turns/productivityTurn.ts): decisión vigente.
- Pruebas: npm test, 23 archivos (lista en scripts/run-tests.mjs).

### Completado — E0 conversacional (rama fix/advisor-e0-natural-opening, desde 17cf398)
Guardado en el commit local 4018a5e (2026-10-20), sin push. E0 ya no se confirma sola con el tercer dato: el estudiante
revisa el resumen y responde que sí (ver "Seguridad semántica y cierre de E0").
- Apertura (src/app/chat/_lib/stage0Opening.ts): un solo emisor de la primera pregunta. Se muestra
  y se guarda una vez por chat, solo si el chat no tiene historial (al recargar no se repite); si el
  estudiante escribe antes, no sale y responde su turno. Stage0PromptTracker, compartido con el
  turno, evita repetir la bienvenida. No compara textos.
- Turno (src/app/chat/_lib/turns/stage0Turn.ts): la intención va antes de extraer. Pedir empezar,
  saludar, "ok", preguntar, pedir ayuda o un ejemplo y "no sé" se responden sin guardar ni llamar a
  Gemini. La ayuda habla del dato que nombra el mensaje ("¿qué significa área de intervención?"
  mientras se pide el rubro) y retoma la pregunta en curso; "no sé" usa lo ya registrado.
- Extracción (stage0Context.ts): compara sobre una copia sin tildes ni mayúsculas que conserva las
  posiciones y recorta el valor del original; reconoce palabras enteras y los verbos de actividad
  por raíz y terminación (antes "Fabricamos" daba "Mos Yogurt" y "área" con tilde no se leía). Cada
  marca (nombre del campo, verbo de actividad, "la venta de", "el área de") abre un tramo hasta la
  siguiente y lo previo a la primera responde la pregunta en curso: cada valor va a un solo campo.
  Los valores se limpian de artículos, dudas y pedidos, el dato va después de la última cópula ("el
  área donde trabajo es producción") y se guardan con mayúscula inicial, sin repetidos, hasta 3.
- Gemini (context/interpret): las mismas reglas para consultarlo (varios campos, sin extracción
  propia, más de 8 palabras, o un verbo de actividad cuando falta el rubro); las señales ahora
  reconocen conjugaciones y tildes. Su lectura manda, pero un producto o un área sin ninguna palabra
  del mensaje no se guarda (groundStage0Extraction); el rubro sí se puede deducir. El prompt prohíbe
  nombres propios y deducir productos o áreas. Si Gemini falla, la extracción propia vale solo para
  mensajes cortos.
- Indicador de etapa: con el contexto en borrador, /api/plans/active-stage responde Etapa 0 aunque
  quede un estado del wizard de E1 (activeStage.ts); el wizard en reposo ({ prodStep: 0 }) ya no se
  guarda (shouldPersistProductivityWizard); una etapa que llega después de cambiar de chat o de modo
  se descarta (refreshActiveAdvisorStage(isCurrent)).
- Nombre (src/lib/chat/studentIdentity.ts, describeChatIdentity): sale del perfil
  (profiles.first_name/last_name) que trae /api/me, resuelto en el servidor con el Bearer;
  useAccessGate lo expone sin otra llamada. Solo se da formato (mayúscula inicial, tildes,
  partículas "de la", nombres compuestos frecuentes como "María José"): un nombre y un apellido.
  Cabecera "Univ. Alan Limachi" solo con role student; saludo "¡Hola, Alan!". Sin perfil, el nombre
  de la cuenta de Google; sin nombre, el correo en la cabecera y el saludo sin nombre (no se arma
  uno con el correo). La apertura de E0 espera a /api/me para saludar con el mismo nombre. El
  perfil no se modifica.
- Bienvenida (buildStage0Opening, estilo de advisorVoice.ts): saludo, "### Etapa 0: Contexto del
  caso", los tres datos y para qué sirven, y la pregunta en negrita en su propio párrafo (unos 550
  caracteres; antes unos 700). Textos de E0 en redacción neutra y con la terminología de "Práctica
  Empresarial" (ver Estilo conversacional).
- Pruebas: stage0Context, stage0Turn, stage0Opening, activeStage y studentIdentity (npm test, 62
  archivos).
- Continuidad única del plan (misma rama). Decisión de Alan: un solo plan activo por estudiante;
  abrir otro chat del asesor recupera ese plan; E0 solo se reinicia con un reinicio explícito; el
  Asistente General sí abre chats nuevos independientes.
  - Causa: E0 es por estudiante, pero E1-E10 guardan su estado por chat (plan_stage_states única
    por user_id + chat_id + stage) y "Nuevo chat" creaba otro chat del asesor (forceNew) con una
    copia del estado o una apertura de E0 nueva.
  - Chat del plan (src/lib/plan/planChat.ts, server-side con la sesión): el del estado de etapa más
    reciente si es un chat del asesor del estudiante (cubre los chats históricos sin migrar ni
    reasignar nada); si no, plan_case_contexts.chat_id; si no hay, se asigna el primero (el chat del
    asesor desde el que se escribe, o uno nuevo) con una escritura condicional: si dos pestañas
    compiten, gana una y la otra oculta el chat vacío que creó. GET /api/plans/context informa ese
    chat; POST con forceNew ya no crea otro ni reinicia el contexto; guardar E0 desde otro chat no
    mueve el plan. /api/plans/review usa el chat del plan si no recibe chatId.
  - Cliente: el arranque del asesor siempre abre el chat del plan (planChatClient.ts decide si
    limpiar la pantalla); "Nuevo chat" en el asesor vuelve a ese chat con un aviso local; en el
    Asistente General abre un chat nuevo sin tocar el plan; la barra lateral lista solo el chat del
    plan entre los del asesor (sin "Eliminar"), o la lista completa si /api/plans/context no responde
    (solo lectura). Ya no existe la marca optia-plan-fresh.
  - Pruebas: planChat (rutas reales sobre Supabase simulado: primer acceso, reingreso, chats
    históricos, entre estudiantes, concurrencia, gates) y planContextRoute (npm test, 63 archivos).
- Seguridad semántica y cierre de E0 (misma rama, 2026-10-20). Corrige la auditoría de 42 mensajes:
  "Eso es confidencial", "Todavía no lo decido" o "Me equivoqué, el rubro es textil" se guardaban
  como datos y el tercero cerraba E0.
  - Actos del mensaje (src/lib/plan/studentMessageActs.ts, pensado para E1-E10, hoy solo E0): por
    cláusulas, rechazo, aplazamiento, delegación (al asesor o a otra persona), vaguedad, duda o
    tentativa, corrección, negación (lo negado nunca cuenta), cambio de empresa y desistir de un
    cambio. Devuelve el texto afirmado con lo demás en blanco; la extracción lee solo eso.
  - Calidad de cada valor (src/lib/plan/stage0Values.ts), igual en cliente y servidor: sin verbos de
    la conversación, negaciones, cuantificadores vacíos, personas ni nombres de empresas o marcas
    (heurística: formas legales, siglas, palabras seguidas con mayúscula, "se llama…"). La lectura de
    Gemini tiene que apoyarse en palabras enteras de lo afirmado (antes bastaba un prefijo de 4
    letras: "Pan" pasaba por "panadería"); el rubro se puede deducir. context/interpret valida en el
    servidor y devuelve los motivos sin los valores; con un JSON inválido responde 502
    INTERPRET_UNREADABLE (antes lo convertía en una pregunta). POST /api/plans/context y
    context/confirm rechazan un valor inválido con 400 INVALID_CONTEXT_VALUE.
  - Cierre: con los tres datos el borrador queda en revisión (estado deducido de plan_case_contexts:
    draft con los tres datos, sin tabla ni endpoint nuevos, así sobrevive a recargas y pestañas). El
    asesor muestra el resumen y pregunta "¿Lo registro así?"; solo un mensaje que entero es un sí
    (isStage0ReviewConfirmation) llama a context/confirm, con los datos revisados en el cuerpo. Una
    corrección cambia el dato y vuelve a mostrar el resumen. El turno lee el contexto al empezar;
    si otra pestaña lo cambió desde el resumen que vio esta, lo muestra de nuevo en vez de confirmar,
    y si otra ya confirmó, no vuelve a confirmar. El borrador se guarda enviando solo los campos que
    cambian. Las respuestas con duda se guardan como provisionales y lo dice.
  - Pruebas: stage0Values, stage0Corpus (los 42 casos con Gemini caído y con Gemini que acierta, 8
    escenarios con Gemini equivocado, revisión, recarga y concurrencia) y stage0ContextRoutes (rutas
    reales con Gemini y Supabase simulados).

### Completado — Biblioteca Académica y RAG académico (rama feat/academic-library, desde 4018a5e)
Commit local, sin push (2026-10-20). M4, M5 y M6 ya están aplicadas en Production (ver "Seguridad
Supabase"); el código que las usa todavía no está desplegado.
- Diagnóstico: los 64 fragmentos anteriores (10 guías en mypes/ y el demo) se generaron con
  text-embedding-004 (norma 1, antes de 65aba99) y no se comparan con las consultas actuales:
  quedan como legacy-768. El demo "productividad y ATO" (demo/opt-ia-demo.txt) originaba las
  respuestas sobre "ATO Fase 1 / CIL"; queda inactivo y no se borra.
- Motor de embeddings (src/lib/embeddingEngine.ts; getEmbeddingEngine en embeddings.ts):
  gemini-embedding-001 con 768 dimensiones pedidas (outputDimensionality), validadas y
  normalizadas; embedQuery (RETRIEVAL_QUERY) y embedDocument(s) (RETRIEVAL_DOCUMENT, lotes de 100).
  Etiqueta "gemini-embedding-001:768". Un vector de otro tamaño, incluido el de 3072, se rechaza:
  no se recorta. embedText (recorte sin normalizar) solo lo usan ya las rutas /api/dev/*.
- Biblioteca docente: pestaña "Biblioteca Académica" en /docente (AcademicLibraryPanel),
  GET y POST /api/teacher/library y POST /api/teacher/library/:id/process, con requireTeacher y
  service role (src/lib/teacher/library/catalog.ts, ingest.ts y processing.ts).
  - Lista solo documentos globales (user_id NULL): formato, estado, fecha y fragmentos por modelo.
    No devuelve texto, embeddings, rutas de Storage ni el hash.
  - Subida de PDF digital o DOCX, sin OCR: hasta 4 MB (límite de Vercel), firma del archivo,
    estructura del zip del DOCX, SHA-256 contra duplicados, hasta 400 páginas y 300 fragmentos de
    hasta 1500 caracteres. Va a Storage (documents/library/<id>.<ext>) y crea la fila en
    processing e inactiva; si la fila falla, se borra el archivo.
  - Procesamiento por pasos de 50 fragmentos que encadena el panel: cada paso vuelve a leer el
    archivo, verifica el hash y regenera los mismos fragmentos. ready solo con todos los índices
    guardados; failed con el motivo; un 429 de Gemini deja processing y el panel espera.
    "Continuar" o "Reintentar" retoma lo guardado (el índice único de M4 evita duplicados).
  - Los documentos nuevos quedan inactivos: activarlos todavía no está implementado.
  - pdf-parse lee mal un Buffer de Node: la Biblioteca usa extractPdfContent (pdfText.ts), que le
    pasa un Uint8Array. extractTextFromPDF (E10) no se tocó (ver deuda).
- RAG académico (src/lib/chat/academicRag.ts, usado por /api/chat): primero
  academic_library_available y, solo si hay material, la pregunta con embedQuery y
  match_academic_chunks (M6): documentos activos, en ready, globales o del usuario de la sesión, y
  con el modelo del motor. Sin material no se llama a Gemini para el embedding y el asistente
  responde con su conocimiento general (el prompt le prohíbe insinuar que consultó documentos).
  Si la búsqueda falla, no hay respaldo en match_document_chunks. Sin fuentes para el estudiante.
  ACADEMIC_RAG_MATCH_COUNT (5 por defecto, 0 la apaga, tope 10) y ACADEMIC_RAG_MIN_SIMILARITY
  (0,5 por defecto, sin calibrar). Hasta reindexar las guías no hay material.
- Logs: /api/chat ya no vuelca las filas del mini-agente SQL (runDbPlan traía nombres de empresas,
  NIT y direcciones): registra la tabla y la cantidad de filas.
- Pruebas: embeddingEngine, academicLibrary, academicLibraryUpload y academicRag (npm test, 70
  archivos; restStubHarness simula Storage y RPC), y PGlite de M4 (50 comprobaciones) y de M6 con
  M4 -> M5 -> M6 (40).
- Pendiente: reindexar las 10 guías desde Storage junto a los legacy-768; activar o desactivar,
  reemplazar, eliminar y ver documentos; "Probar búsqueda" y calibrar el umbral; retirar las
  variantes de match_document_chunks, /api/dev/index-* y /dev/index-pdf; sincronizar el historial
  de migraciones.

### En curso — Panel docente nativo (rama feat/docente-native-dashboard, desde 9048927)
Las pruebas funcionales reales E0-E10 van DESPUÉS del panel docente. Los bugs funcionales
conocidos (ver deuda) no se corrigen dentro del panel.
- Dashboard docente: NATIVO (GET /api/teacher/dashboard + src/components/teacher/dashboard).
  Looker Studio está descartado y eliminado de la UI; NEXT_PUBLIC_LOOKER_REPORT_URL ya no la
  usa el código.
- Siguiente objetivo: detalle nativo por estudiante y filtros académicos.
  - Nivel 1, cohorte: visión general, estudiantes, aprobación, horas, avance E0-E10, filtros.
  - Nivel 2, estudiante: selección, progreso E0-E10, evaluaciones disponibles, horas,
    actividad, documento final y versiones, y cortes/avances SOLO según datos reales: se
    auditan antes de D3, sin inventar tablas ni columnas.

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
  - E0: corregido en fix/advisor-e0-natural-opening (ver E0 conversacional). Queda: con Gemini
    caído, una respuesta de más de 8 palabras afirmadas no se guarda y se pide resumirla; actos y
    calidad son reglas y una frase poco habitual puede leerse mal (no se confirma sin el sí del
    estudiante); la detección de nombres de empresas es heurística (dos palabras seguidas con
    mayúscula pueden tomarse por un nombre, y un nombre en minúsculas no se detecta); después de
    confirmar, corregir E0 sigue exigiendo un reinicio explícito (decisión pendiente de Alan).
  - Historial (useChatHistory): la respuesta vieja al cambiar de chat ya se descarta (continuidad
    única del plan); sigue que un chat vacío conserva los mensajes anteriores (en el asesor lo cubre
    planChatEntry) y que messagesRef/chatIdRef se actualizan en effects.
  - Auth (useAccessGate): en un 403 compiten dos redirecciones; el gate no se reevalúa si la
    cuenta cambia sin pasar por "sin sesión".
  - Transiciones: E5 restaurado con estado inválido queda sin estado (cae en /api/plans/review);
    E3 se restaura saneado o no según el camino; clearAdvisorStageStatesLocal no limpia
    prodStep, prodDraft, stage0Draft, editingField ni brainstormClosePending; mínimos iniciales
    de Ishikawa 3/2/1 frente al comentario 4-5/2-3/2-3.
  - E4: validateIshikawa usa el chatId del render (puede ser viejo).
  - Tipos duplicados: ChatRouter (useAccessGate.ts y useChatHistory.ts); ChatMode (page.tsx y
    Sidebar.tsx).
- Restos de Looker en la base (no tocados): el rol looker_reader y las 7 views BI siguen
  existiendo. v_student_usage NO es descartable: /api/teacher/dashboard la usa para la
  actividad del estudiante.
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
- E10: extractTextFromPDF (src/lib/pdfText.ts) le pasa un Buffer a pdf-parse, y su pdf.js 1.10 lee
  mal cualquier Buffer de Node ("bad XRef entry" con PDFs válidos; verificado en Node 22.16): la
  extracción de PDF de /api/plans/upload probablemente falla. Corregirlo es una línea, pero toca
  E10: decisión de Alan.
- /api/chat: si el plan del mini-agente SQL no se puede parsear, se registra el texto crudo de
  Gemini (console.error en planDbQuery), que puede traer nombres de empresas del mensaje.
- Panel docente sin navegación móvil: la barra lateral es hidden md:block en todas las pestañas.

## Seguridad Supabase (aplicada y verificada el 2026-10-04; M4-M6 el 2026-10-20)
Proyecto luvcduxkasaeyobdyafj. Cualquier cambio nuevo de esquema, RLS o grants sigue
necesitando autorización explícita de Alan. apply_migration asigna una versión nueva: después
de aplicar, renombrar el archivo local a esa versión (git mv, contenido intacto).
El historial remoto NO coincide con supabase/migrations/: termina en 20261019005428 (M3) y le
faltan M4, M5 y M6 (aplicadas a mano) y también 20260606120000 y 20260606123000. Sincronizarlo
sin reaplicar SQL (supabase migration repair --status applied <versiones>, después de verificar
en modo lectura los efectos de las dos de 202606) está pendiente de autorización. No correr
supabase db push antes: reintentaría aplicarlas.

Aplicadas a mano el 2026-10-20 (versión local; sin registrar en el historial remoto):

| Versión local | Migración | Qué hace |
|---|---|---|
| 20261020150000 | academic_library_documents (M4) | documents: is_active, status, file_type, content_hash (único), processing_error, updated_at; document_chunks: embedding_model (los 64 = legacy-768) y único (document_id, embedding_model, chunk_index); demo inactivo |
| 20261020180000 | academic_library_client_writes (M5) | authenticated sin INSERT, UPDATE, DELETE ni TRUNCATE en documents y document_chunks; quedan las policies de lectura propia y de delete en false |
| 20261020200000 | academic_library_rag (M6) | match_academic_chunks y academic_library_available, EXECUTE solo para service_role; las variantes de match_document_chunks no cambian |

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
- Las dos variantes de match_document_chunks siguen ejecutables por anon y authenticated (son
  SECURITY INVOKER y la RLS las limita); el código nuevo ya no las usa: retirarlas.
- Auth: leaked password protection deshabilitado (poco relevante: el acceso es Google OAuth).
- Advisors de rendimiento: 40 auth_rls_initplan (auth.uid() sin `(select ...)`),
  4 multiple_permissive_policies (cohort_events, cohorts, hours_entries, profiles),
  4 pares de índices duplicados, 5 foreign keys sin índice, 15 índices sin uso.
