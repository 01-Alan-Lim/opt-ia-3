# M3: acceso académico automático e invitaciones de Calendar

Qué cambia, qué hay que configurar fuera del código y en qué orden publicarlo. Rama
`feat/academic-access-calendar`. Migración `20261018230000_student_email_authorizations_calendar_organizer`.

## Qué cambia

1. **Acceso de estudiantes.** Los correos `@umsa.bo` (`ALLOWED_EMAIL_DOMAIN`) entran solos. Un correo
   personal (p. ej. Gmail) entra solo si un docente lo autoriza en el panel (pestaña Aprobaciones →
   "Correos personales autorizados"), sin tocar variables de entorno. **Entrar no es estar
   aprobado**: todos pasan por onboarding → pendiente → aprobación docente → acceso.
2. **Revocación.** Revocar un correo le quita el acceso aunque siga en
   `STUDENT_TEST_EMAIL_ALLOWLIST`: la revocación prevalece sobre la lista heredada.
3. **Onboarding.** Reenviar el formulario en la misma cohorte ya no quita una aprobación. Cambiar
   de cohorte o reenviar tras un rechazo vuelve a dejarlo pendiente.
4. **Calendar.** Los estudiantes ya no conectan su Google Calendar (se retiró del onboarding y de
   `/hours`; las rutas `/api/integrations/google-calendar/*` responden 410). Un docente conecta una
   **cuenta organizadora** y OPT-IA envía a cada estudiante aprobado las fechas de su cohorte como
   invitaciones, que se actualizan si cambian las fechas y se cancelan cuando corresponde.
5. **Login.** El acceso alternativo por OAuth ya no se muestra siempre: solo si falla el inicio
   con Google Identity Services, o si se abre el landing con `?acceso=alternativo` (recuperación
   para soporte). Sin GIS, el botón principal sigue siendo el OAuth, como antes.

## Acceso de estudiantes (`src/lib/auth/studentEmailAuthorization.ts`)

| Correo | ¿Entra? |
|---|---|
| Docente (`TEACHER_EMAIL_ALLOWLIST`) | Sí, como docente |
| `@umsa.bo` | Sí |
| Personal con autorización activa | Sí |
| Personal revocado (filas en la tabla, ninguna activa) | **No**, aunque esté en la lista heredada |
| Personal sin filas, en `STUDENT_TEST_EMAIL_ALLOWLIST` | Sí (transición) |
| Personal sin filas ni lista | No |

Si la tabla todavía no existe (M3 sin aplicar), cuenta solo la lista heredada: nadie pierde el
acceso. Un error de la base distinto de "la tabla no existe" falla cerrado (500, sin acceso).

## Invitaciones de Calendar

**Quién las recibe:** estudiantes aprobados de la cohorte, con un correo que hoy podría entrar
(tabla de arriba), para cada evento habilitado de su cohorte con fecha de hoy en adelante.

| Acción | Efecto en Calendar |
|---|---|
| Aprobar | Se envían sus invitaciones |
| Rechazar o deshabilitar | Se cancelan las futuras |
| Revocar su correo / volver a autorizarlo | Se cancelan / se reactivan |
| Cambiar de cohorte (onboarding) | Se cancelan las de la cohorte anterior |
| Guardar la cohorte (fechas, hora, enlaces) | Se actualizan solo las que cambiaron |
| Deshabilitar un evento | Se cancela para todos |
| "Sincronizar ahora" (Configuración) | Reconciliación completa |

- Los eventos ya pasados no se crean, ni se actualizan, ni se cancelan (no hay avisos sobre fechas
  pasadas).
- La aprobación y los demás cambios se guardan **antes** de llamar a Google: si Google falla, el
  cambio queda hecho, el panel muestra el error y la invitación queda pendiente para la siguiente
  sincronización.
- Cada evento tiene un único invitado y `sendUpdates=all`. Los invitados no ven a otros invitados
  ni pueden modificar el evento. Visibilidad privada, sin bloquear tiempo.
- **Contenido:** "OPT-IA · <actividad>", la fecha a la hora de recordatorio de la cohorte (30 min,
  zona `DEFAULT_TIMEZONE` o `America/La_Paz`), el enlace del formulario de la cohorte y el de OPT-IA.
  Nunca la empresa, el nombre del estudiante, su RU ni el nombre de la cohorte.
- **Sin duplicados:** el ID de cada evento es determinista (cuenta organizadora + evento de cohorte
  + estudiante, en base32hex) y hay un único registro por estudiante y evento. Repetir una
  sincronización, o lanzar dos a la vez, no crea un segundo evento.
- **Reintentos:** 429, 5xx, límites de frecuencia y fallos de red, hasta 3 intentos con espera
  creciente (o `Retry-After`). Cada ejecución tiene un límite de tiempo; lo que no alcanza queda
  pendiente y el panel pide pulsar "Sincronizar".
- **Cambiar de cuenta organizadora:** no se permite mientras haya invitaciones activas enviadas por
  la anterior (solo esa cuenta puede actualizarlas o cancelarlas). Primero "Retirar invitaciones"
  con la cuenta anterior conectada; después conectar la nueva y sincronizar.
- **Desconectar** revoca el acceso en Google y borra la conexión. Las invitaciones ya enviadas
  siguen en los calendarios de los estudiantes, pero dejan de actualizarse hasta reconectar la misma
  cuenta.

**Seguridad.** El OAuth del organizador se hace en el servidor con CSRF (state + cookie httpOnly,
SameSite=strict, de un solo uso, limitada a `/api/teacher/calendar-organizer`). El refresh token se
guarda cifrado (AES-256-GCM) con `CALENDAR_TOKEN_ENCRYPTION_KEY`; la base solo ve el texto cifrado y
el navegador nunca recibe tokens. Las tablas nuevas no tienen permisos para `anon` ni
`authenticated` (solo `service_role`). Todas las rutas del organizador son solo para docentes.

Código: `src/lib/calendar/*`, `src/app/api/teacher/calendar-organizer/*`,
`src/app/api/teacher/cohorts/[id]/calendar/sync/route.ts`,
`src/components/teacher/CalendarOrganizerPanel.tsx`.

## Variables (solo nombres)

| Variable | Entorno | Notas |
|---|---|---|
| `CALENDAR_TOKEN_ENCRYPTION_KEY` | **Solo Production**, solo servidor | **Nueva.** Base64 de exactamente 32 bytes aleatorios, independiente de cualquier otro secreto. Nunca con prefijo `NEXT_PUBLIC_`: si existe `NEXT_PUBLIC_CALENDAR_TOKEN_ENCRYPTION_KEY`, el servidor rechaza la clave y el calendario queda desactivado. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Production, solo servidor | Ya los usaba el Calendar por estudiante: verificar que existen. Cliente OAuth web (ver Google Cloud). |
| `ALLOWED_EMAIL_DOMAIN` | Todos | `umsa.bo` (sin cambios). |
| `TEACHER_EMAIL_ALLOWLIST` | Todos | Sin cambios. |
| `STUDENT_TEST_EMAIL_ALLOWLIST` | Todos | Lista heredada. Con M3 aplicada ya no hace falta añadir correos aquí; se puede vaciar cuando el panel muestre a los estudiantes heredados como autorizados. |
| `DEFAULT_TIMEZONE` | Opcional | Zona de los eventos; por defecto `America/La_Paz`. |
| `VERCEL_PROJECT_PRODUCTION_URL` | Automática (Vercel) | Enlace a OPT-IA dentro de la invitación. Si no existe, se usa el origen de la petición. |

Generar la clave en una máquina de confianza, sin guardarla en el repositorio, y pegarla
directamente en Vercel:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

**Por qué solo en Production.** Preview y el entorno local pueden apuntar a la misma base que
Production. Con la clave configurada, un Preview enviaría invitaciones reales a estudiantes reales,
y conectar la cuenta desde allí reemplazaría la conexión de Production. Sin la clave, Preview y
local muestran "Falta configurar el calendario", no envían nada y no pueden desconectar la cuenta
(un token que no pueden leer tampoco la desconecta). No poner la clave en `.env.local` si apunta a
la base de Production.

**Rotación de la clave:** la conexión guardada deja de poder leerse; el panel lo indica y basta
con volver a conectar la misma cuenta (las invitaciones se conservan).

## Google Cloud (cliente de `GOOGLE_OAUTH_CLIENT_ID`)

1. **APIs & Services → Library:** habilitar **Google Calendar API** en el proyecto del cliente.
2. **Credentials → cliente OAuth web → Authorized redirect URIs:** debe contener
   `https://opt-ia.vercel.app/auth/calendar-callback` (la misma URI que usaba el Calendar por
   estudiante; si ya está, no hay que cambiar nada). Para probar en local:
   `http://localhost:3000/auth/calendar-callback` (con la advertencia de la base compartida).
3. **Google Auth Platform → Data access:** añadir los alcances `openid`, `.../auth/userinfo.email`
   y `https://www.googleapis.com/auth/calendar.events` (sensible).
4. **Audience:** tipo **External** y estado de publicación **In production**. En **Testing**, Google
   caduca los refresh tokens a los 7 días: la cuenta organizadora quedaría desconectada cada
   semana (el panel mostraría "Google revocó o caducó el acceso").
5. Branding: el mismo que el login (nombre OPT-IA, página principal, privacidad y términos en
   `opt-ia.vercel.app`).
6. **Cuenta organizadora:** usar una cuenta de Google dedicada a la materia (no la personal del
   docente), con acceso de al menos dos docentes. Es el remitente visible de las invitaciones.

## Limitaciones de Google sin dominio propio

- **App sin verificar.** `calendar.events` es un alcance sensible y Google pide verificar la app
  para usarlo sin advertencias. La verificación exige un dominio propio verificado (página
  principal y política de privacidad en ese dominio); con `opt-ia.vercel.app` en la práctica no es
  viable. Sin verificar, la cuenta organizadora ve una vez la pantalla "Google no verificó esta
  app" (Configuración avanzada → Ir a OPT-IA) y la app tiene un límite de 100 usuarios para
  alcances sensibles. No afecta: solo la cuenta organizadora autoriza Calendar. El login de los
  estudiantes usa alcances básicos y no muestra esa advertencia.
- **In production sin verificar** está permitido y evita la caducidad semanal de Testing.
- **Recordatorios:** los del organizador no se aplican a los invitados. Cada estudiante recibe los
  avisos que tenga por defecto en su calendario (se usa `useDefault`).
- **Workspace de la UMSA:** si `umsa.bo` es un Google Workspace, su administración puede limitar
  las invitaciones de remitentes externos (p. ej. añadirlas al calendario solo si el remitente es
  conocido). El correo de invitación llega igual; aceptar la primera invitación ayuda. Verificar
  con una cuenta de prueba `@umsa.bo` antes de anunciarlo.
- **Límites de envío:** Google limita las invitaciones que una cuenta personal envía a invitados
  externos. Si se superan, Google rechaza temporalmente (el panel muestra los errores) y
  "Sincronizar" lo reintenta más tarde. Con cohortes grandes, sincronizar por partes.
- El correo de las invitaciones lo envía Google en nombre de la cuenta organizadora; OPT-IA no
  envía correos.

## Supabase: aplicar M3

M3 no se ha aplicado en ninguna base. Requiere autorización explícita para Production.

**Compatibilidad.** El código de esta rama funciona con y sin M3 (sin M3: lista heredada, panel de
correos y calendario muestran "falta preparar la base de datos", las aprobaciones funcionan). El
código de `main` funciona con M3 aplicada (no lee las tablas nuevas). Orden recomendado: M3 primero,
después el despliegue.

**Preflight (solo lectura):**

```sql
-- Estudiantes no institucionales que M3 autorizará (deben ser los excepcionales actuales).
select registration_status, count(*)
from public.profiles
where role = 'student' and email is not null and lower(btrim(email)) not like '%@umsa.bo'
group by registration_status;

-- Tablas de Calendar existentes: se esperan 0 filas.
select (select count(*) from public.user_google_calendar_event_map) as event_map_rows,
       (select count(*) from public.user_google_calendar_tokens) as token_rows;

-- Las tablas nuevas no deben existir todavía.
select to_regclass('public.student_email_authorizations'), to_regclass('public.calendar_organizer');
```

**Aplicación:** el archivo de `supabase/migrations/` tal cual (una transacción; termina con
`notify pgrst, 'reload schema'`). **Verificación:** `supabase/manual/20261018230000_m3_verify.sql`
(18 filas con `ok = true`, activas = estudiantes heredados, 0 filas en el mapeo).

**Riesgos:**
- La carga inicial autoriza a todos los estudiantes no institucionales aprobados o **pendientes**.
  Si hay alguno pendiente que no debería entrar, revocarlo en el panel después de aplicar.
- Los rechazados no se cargan: si siguen en `STUDENT_TEST_EMAIL_ALLOWLIST` conservan la entrada
  (y siguen sin aprobación).
- Se retira la escritura de `authenticated` en `user_google_calendar_event_map` y
  `user_google_calendar_tokens`. Ningún cliente escribe ahí (0 filas; el flujo por estudiante se
  retira en esta versión).
- Tablas pequeñas: los bloqueos son breves.

**Rollback:** `supabase/manual/20261018230000_m3_rollback.sql`. Se pierden las autorizaciones, las
**revocaciones** (un revocado que siga en la lista heredada recupera el acceso), la conexión del
organizador y el registro de invitaciones (las ya enviadas quedan en los calendarios sin poder
actualizarse). No toca `profiles` ni `cohort_events`.

Prueba local de M3 (PGlite, sin red): `node supabase/tests/m3_authorizations_calendar.pglite.mjs <carpeta-con-@electric-sql/pglite>`.

## Orden de publicación

1. Push de la rama y PR; checks de Vercel en Preview **sin** `CALENDAR_TOKEN_ENCRYPTION_KEY`
   (login, onboarding, aprobación, panel de correos; el panel de calendario debe decir "Falta
   configurar").
2. Preflight de M3 (lectura) y, con autorización, aplicar M3 en Production; `m3_verify.sql`.
3. Google Cloud: Calendar API, URI de retorno, alcances y estado **In production**.
4. Vercel Production: crear `CALENDAR_TOKEN_ENCRYPTION_KEY`; comprobar `GOOGLE_OAUTH_CLIENT_ID` y
   `GOOGLE_OAUTH_CLIENT_SECRET`.
5. Merge a `main` (despliegue de Production con las variables nuevas).
6. En `https://opt-ia.vercel.app/docente` → Configuración: "Conectar cuenta organizadora" con la
   cuenta dedicada. Al volver se sincroniza todo una vez.
7. Comprobar con una cuenta de prueba aprobada (`@umsa.bo` y Gmail autorizado) que llega la
   invitación, que cambiar una fecha la actualiza y que rechazar la cancela.
8. Opcional: vaciar `STUDENT_TEST_EMAIL_ALLOWLIST` cuando el panel muestre a los estudiantes
   heredados como autorizados.
