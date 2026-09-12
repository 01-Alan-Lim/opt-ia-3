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

### En curso — Tanda 2: profundidad variable de porqués en Ishikawa
Problema: maxWhyDepth está fijo en 3 y al tercer porqué la rama se cierra
automáticamente como "causa raíz suficientemente clara", sea accionable o no
(ishikawa/assistant:2225-2239). Eso produce causas raíz pobres.
Objetivo: tope de 5 porqués, con cierre por CALIDAD (la causa es accionable),
no por contador. Si a los 5 sigue sin ser accionable, el sistema ayuda a
reformular en vez de aceptar cualquier cosa.

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

## Pendientes de seguridad (NO tocar sin autorización)
- 7 views BI son SECURITY DEFINER y anon tiene SELECT: fuga de datos de
  estudiantes con la anon key pública.
- profiles_update_own no restringe columnas: un estudiante puede ponerse
  role='teacher' y activar las policies IS_TEACHER de RLS.
