# R1: autenticidad de los mensajes del asesor (activación)

Qué hace falta para activar en Preview y Production el cierre de R1: que nadie pueda guardar en
`messages` un texto atribuido al asistente que el servidor no emitió.

## Modelo de procedencia (`src/lib/chat/messageProvenance.ts`)

| role guardado | Qué es | Quién lo escribe |
|---|---|---|
| `user` | Texto del estudiante | `/api/messages`, `/api/chat`, `/api/plans/review` |
| `assistant` | Texto emitido por el servidor | `/api/messages` **solo con recibo verificado** (`receipt_nonce`), o `/api/chat` y `/api/plans/review` con su propia respuesta |
| `advisor` | Texto local del asesor generado en el navegador (guías, transiciones, validaciones, reanudaciones, E0) | `/api/messages`, solo en chats `plan_mejora`. Nunca se atribuye a la IA |
| `assistant` sin `receipt_nonce` anterior a M2 | Histórico (mezcla de respuestas reales y textos locales) | No se reclasifica |

Un recibo prueba que el servidor emitió ese texto para ese usuario y ese chat, no que lo haya
escrito Gemini: también se firman los textos fijos de las rutas assistant.

## Variables (solo nombres)

| Variable | Dónde | Notas |
|---|---|---|
| `ASSISTANT_RECEIPT_SECRET` | Vercel → Environment Variables, **solo servidor** | Base64 de al menos 32 bytes aleatorios. **Distinto** en Preview y en Production. Nunca con prefijo `NEXT_PUBLIC_`: si existe `NEXT_PUBLIC_ASSISTANT_RECEIPT_SECRET`, el servidor rechaza la clave y no firma ni verifica nada. |

Las demás variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, ...) no cambian.

Generar un valor en una máquina de confianza, sin guardarlo en el repositorio ni en archivos
compartidos, y pegarlo directamente en Vercel:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Sin la variable, la aplicación sigue funcionando: las rutas no firman, las respuestas se guardan
como `advisor` (sin atribuirlas a la IA) y `/api/messages` responde 503
`RECEIPT_KEY_UNAVAILABLE` a cualquier `assistant`, con un único aviso en los logs, sin valores.

**Rotación:** invalida los recibos en curso (duran 15 minutos). Una respuesta que llegue al
navegador antes de rotar y se guarde después se rechaza (403) y el estudiante ve el aviso de
mensaje no guardado. Rotar fuera del horario de uso.

## Migración M2

`supabase/migrations/20261018184547_message_provenance_receipt_idempotency.sql` (versión registrada en Supabase)

- Admite `role = 'advisor'` y deja de admitir `system` (0 filas).
- Añade `receipt_nonce` (único en toda la tabla) y `client_message_id` (único por chat).
- Es aditiva y compatible con el código anterior (`main`), por eso se aplica **antes** del
  despliegue. Sin M2, el código nuevo responde 503 `SCHEMA_NOT_READY` y no guarda nada.
- Verificación posterior: `supabase/manual/20261018160000_m2_verify.sql` (solo lectura).
- Prueba local: `node supabase/tests/m2_message_provenance.pglite.mjs <carpeta-con-pglite>`.
- Al aplicarla con una herramienta que registre otra versión, alinear el nombre del archivo
  con la versión registrada (como se hizo con M1).

## Orden de activación

Preview usa la misma base de datos que Production, así que M2 va primero.

1. Guardar el resultado de la consulta 2 de `m2_verify.sql` (conteos por role).
2. Aplicar M2 en Supabase. Ejecutar `m2_verify.sql`: 7 comprobaciones `ok = true`, mismos
   conteos, columnas nuevas en 0 y `authenticated` sin escritura.
3. Configurar `ASSISTANT_RECEIPT_SECRET` en Vercel para **Preview** (valor A).
4. Publicar la rama de release y desplegar Preview. Con la cuenta de prueba, recorrer el
   checklist (abajo).
5. Configurar `ASSISTANT_RECEIPT_SECRET` en Vercel para **Production** (valor B, distinto de A).
6. Fusionar la release en `main` (despliega Production) y repetir el checklist abreviado.

### Checklist (cuenta de prueba)

- E0 completo: las preguntas del contexto se ven y, tras recargar, siguen ahí.
- Un turno de E1 y otro de E2: tras recargar, las respuestas del asesor siguen visibles.
- En la base, para ese chat: las respuestas de las rutas son `assistant` con `receipt_nonce`;
  los textos locales son `advisor`; ningún `assistant` nuevo sin `receipt_nonce`.
- `POST /api/messages` con `role: "assistant"` sin recibo → 403 `ASSISTANT_RECEIPT_REQUIRED`.
- `POST /api/plans/context` con `assistantMessage` → 400.
- Logs sin `[messages] no se pueden verificar recibos` (la variable está bien configurada).

## Reversión

- **Preferible: revertir solo el código** (redeploy del commit anterior). M2 es compatible con
  el código anterior; las filas `advisor` se siguen viendo como mensajes del asesor.
- Quitar `ASSISTANT_RECEIPT_SECRET` no revierte nada por sí solo: las respuestas pasan a
  guardarse como `advisor`.
- Revertir M2 (`supabase/manual/20261018160000_m2_rollback.sql`) solo después de revertir el
  código y si no hay filas `advisor`: el script se niega a continuar si las hay, porque
  devolverlas a `assistant` las atribuiría a la IA.
