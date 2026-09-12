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
Rama de trabajo actual: fix/advisor-unblock-e4-e5
Auditoría read-only completa (fases 1-3) realizada. Hallazgos principales:
deadlock E4->E5, clasificación errónea de "no se", desincronización de
estado en FODA, historial invertido en /api/chat.

## Pendientes de seguridad (NO tocar sin autorización)
- 7 views BI son SECURITY DEFINER y anon tiene SELECT: fuga de datos de
  estudiantes con la anon key pública.
- profiles_update_own no restringe columnas: un estudiante puede ponerse
  role='teacher' y activar las policies IS_TEACHER de RLS.
