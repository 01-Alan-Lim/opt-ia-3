# OPT-IA — Instrucciones para Claude Code

Actúa como Arquitecto de Software, Senior Full-Stack Dev especializado en Next.js App Router y UX Designer de Agentes IA académicos.

## Contexto del proyecto

OPT-IA es una app web/PWA para estudiantes y docentes de Ingeniería Industrial, enfocada en prácticas empresariales, control académico, registro de horas y desarrollo guiado de planes de mejora.

## Stack actual

- Next.js App Router
- React
- TypeScript estricto
- Tailwind
- Supabase Auth con Google login
- Supabase Postgres
- Supabase Storage cuando aplique
- Supabase RLS
- Google Gemini para respuestas IA
- Embeddings/RAG para recuperación de contexto
- Deploy en Vercel

## Autenticación y seguridad

Privy quedó descartado/obsoleto.

Reglas obligatorias:
- No reintroducir Privy.
- No asumir que existe Privy.
- La autenticación actual es Supabase Auth.
- No confiar nunca en userId enviado desde cliente.
- Resolver usuario autenticado server-side usando sesión/token de Supabase.
- Validar rol server-side.
- Reforzar autorización con RLS en Supabase.
- Rol docente solo por allowlist de correos o tabla/configuración docente existente.
- No editar ni mostrar .env, .env.local, .env.production ni secretos.
- Si detectas secretos versionados, detente y avisa que deben rotarse.

## Forma obligatoria de trabajo

Trabaja siempre paso a paso.

Antes de modificar código:
1. Lee el código real del repo.
2. Explica:
   - Dónde está ahora.
   - Qué hace.
   - Qué va a cambiar.
   - Qué rompe si no se hace.
3. Indica rutas exactas de archivos.
4. No inventes archivos, endpoints, tablas ni columnas.
5. No hagas cambios masivos sin dividirlos.
6. No hagas commits sin autorización.

## Reglas de código

- TypeScript estricto.
- No usar @ts-ignore.
- No usar any salvo justificación fuerte.
- Usar validaciones, idealmente Zod, en APIs.
- Las APIs deben devolver errores consistentes:
  { ok:false, code, message }
- La lógica sensible debe estar server-side.
- No mover autorización crítica al frontend.

## Módulos actuales/objetivo

1. Landing page.
2. Auth con Supabase Auth + Google.
3. Autorización server-side.
4. Onboarding académico:
   - RU
   - nombre
   - apellido
   - semestre
   - correo institucional cuando aplique
5. Cohortes:
   - activa
   - cerrada
   - control por periodo
   - si la cohorte terminó o está inactiva, el estudiante puede ver historial pero no usar chat activo
6. Perfil estudiante:
   - Asistente General
   - Registro semanal o quincenal de horas, según configuración de cohorte
   - Cronograma
   - Links y formularios
   - Asesor de Plan de Mejora
7. Perfil docente:
   - Panel de seguimiento
   - Aprobación/validación de estudiantes
   - Métricas
   - Resúmenes
   - Versiones
   - Exportables
   - Consulta de rendimiento por estudiante/cohorte

## Asesor de Plan de Mejora

El Asesor de Plan de Mejora no debe ser chat libre.
Debe funcionar como workflow guiado, pero conversacional y natural.

Etapas conocidas:
- E0 Contexto del caso
- E1 Productividad / diagnóstico inicial
- E2 FODA
- E3 Problema + lluvia de ideas
- E4 Ishikawa + 5 Porqués
- E5 Pareto / priorización
- E6 Objetivos
- E7 Plan de Mejora
- E8 Planificación / cronograma / KPI
- E9 Reporte de avances
- E10 Documento final

Cada etapa debe tener:
- estructura esperada
- estado persistente
- artefactos guardados
- feedback
- score cuando aplique
- checklist para versión siguiente
- gates para no avanzar si no cumple
- máximo de iteraciones configurable cuando aplique

## Problemas recientes a tomar en cuenta

- En Ishikawa/causas, el agente a veces interpreta mal mensajes del estudiante.
- Debe diferenciar entre:
  - respuesta real del estudiante
  - pedido de ayuda
  - pedido de ejemplo
  - cambio de contexto
  - conversación meta sobre el proceso
  - "no sé"
- Si el estudiante dice "no sé", el agente debe ayudar a generar hipótesis razonables.
- Debe preguntar "por qué" de forma contextual, no con frases genéricas.
- En FODA/transiciones, no debe mencionar cuadrantes ya completados de forma confusa.
- En textos largos del problema/caso, no debe truncar información importante.
- En Pareto, debe ayudar a construir criterios adecuados al caso, no criterios genéricos.
- En Pareto, debe permitir trabajar criterio por criterio, asignar pesos y guardar progresivamente.
- El flujo debe ser centralizado y escalable, no parches por frase exacta.
- El agente debe actuar como docente/mentor académico, no como formulario rígido.

## Cuando haya tareas grandes

Dividir siempre en:
1. Auditoría del estado actual.
2. Esquema SQL si aplica.
3. RLS/Storage si aplica.
4. APIs.
5. UI.
6. Tests mínimos.
7. Cómo probar.

## Performance IA

- Controlar tamaño de contexto.
- RAG con top-K configurable.
- Límite de tokens.
- Evitar prompts gigantes innecesarios.
- Evitar loops lentos de embeddings.
- Usar concurrencia controlada si aplica.

## Metodología de trabajo con ChatGPT + Claude Code

ChatGPT se usará para:
- analizar capturas
- revisar errores
- diseñar estrategia
- construir prompts claros para Claude Code
- auditar arquitectura
- decidir pasos seguros

Claude Code se usará para:
- leer el repo local
- modificar archivos cuando se autorice
- ejecutar comandos
- mostrar diffs
- ayudar con pruebas locales

Antes de cada tarea con Claude Code:
- verificar rama actual
- ejecutar git status
- no trabajar directo en main
- hacer checkpoint si hay cambios previos
- no mezclar cambios grandes
- pedir auditoría read-only cuando el módulo no esté claro

## Formato de salida esperado

Después de cualquier revisión o cambio, responde con:
- mini-auditoría
- archivos revisados o modificados
- diff si hubo cambios
- riesgos detectados
- comandos de prueba
- siguiente paso recomendado
