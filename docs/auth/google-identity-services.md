# Inicio de sesión con Google Identity Services (GIS)

El botón principal del landing es el botón oficial de Google. Google entrega un ID token en el
navegador y Supabase Auth lo valida con `signInWithIdToken`. Supabase sigue siendo la única
sesión: roles, RLS, onboarding, cohortes y `/api/auth/after-login` no cambian. Como no hay
redirección a `<ref>.supabase.co`, Google ya no muestra ese dominio.

El OAuth anterior (`signInWithOAuth`) sigue disponible como respaldo:
- como enlace "¿Problemas? Ingresa con el método alternativo" bajo el botón de Google;
- como botón principal, igual que antes, si falta `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, si el script
  de Google no carga en 8 s o si falla.

Código: `src/lib/auth/googleIdentity.ts`, `src/lib/auth/loginClient.ts`,
`src/lib/auth/finishLogin.ts`, `src/components/LoginButton.tsx`.

Google Calendar no cambia: usa su propio flujo OAuth (`/api/integrations/google-calendar/*`,
`GOOGLE_OAUTH_CLIENT_ID`) y el login no pide permisos de Calendar.

## Configuración externa (pendiente; no la hace el código)

### A. Google Cloud

1. Identificar el client ID web correcto: en Supabase → Authentication → Sign In / Providers →
   Google, el campo **Client IDs** contiene el ID que usa hoy el login (no es secreto; si hay
   varios, el del cliente web). En Google Cloud
   Console → APIs & Services → Credentials (o Google Auth Platform → Clients), abrir el cliente
   OAuth de tipo **Web application** con ese mismo ID.
2. En ese cliente, **Authorized JavaScript origins**, añadir (esquema y host, sin ruta ni barra
   final):
   - `https://opt-ia.vercel.app`
   - `http://localhost`
   - `http://localhost:3000`
   - el origen estable de Preview (abajo).
3. No tocar **Authorized redirect URIs**: el callback de Supabase sigue haciendo falta para el
   OAuth de respaldo, y los de `/auth/calendar-callback` para Calendar.
4. Branding: nombre de la app "OPT-IA", página principal `https://opt-ia.vercel.app`, política
   de privacidad `https://opt-ia.vercel.app/privacy`, términos `https://opt-ia.vercel.app/terms`,
   y `opt-ia.vercel.app` entre los dominios autorizados.
5. Los cambios de orígenes pueden tardar desde unos minutos hasta algunas horas en aplicarse.

**Origen de Preview.** Google no admite comodines, y cada despliegue de Preview tiene una URL
con hash distinta. Hay que usar la URL de rama, que no cambia entre despliegues de la misma
rama: en Vercel → proyecto → Deployments → el despliegue de Preview de la rama → **Domains**,
copiar el dominio que contiene `-git-` y añadirlo con `https://`. En las URLs con hash funciona
solo el OAuth de respaldo.

### B. Supabase

En Authentication → Sign In / Providers → Google:
- el campo **Client IDs** (lista separada por comas) debe incluir el mismo client ID web que usa
  el botón de GIS;
- **Skip nonce check** debe seguir desactivado: el código manda el nonce.

No hace falta tocar tablas, políticas ni migraciones.

### C. Vercel

1. Settings → Environment Variables → crear `NEXT_PUBLIC_GOOGLE_CLIENT_ID` con el client ID web,
   en **Preview** y, cuando se publique, en **Production**. Es público: Next.js lo incluye en el
   código del navegador.
2. **Requiere un despliegue nuevo.** Las variables `NEXT_PUBLIC_*` se incrustan al compilar: un
   despliegue anterior no la ve. En Preview basta con un push a la rama o con Redeploy.
3. En local: `NEXT_PUBLIC_GOOGLE_CLIENT_ID` en `.env.local` y `npm run dev`. Abrir
   `http://localhost:3000`.

Sin la variable, el login funciona como siempre (OAuth).

## Prueba en Preview (cuenta de prueba)

- El botón de Google aparece en el landing y el diálogo de Google no menciona `supabase.co`.
- Iniciar sesión: estudiante → `/chat` (u onboarding si es nuevo); docente → `/docente`;
  correo no autorizado → `/?reason=forbidden` y sesión cerrada.
- El `user_id` de la cuenta no cambia respecto al login anterior (no hay usuario duplicado).
- Cerrar sesión y volver al landing: no se inicia sesión sola.
- Bloquear `accounts.google.com/gsi/client` (DevTools → Network request blocking) y recargar:
  aparece el botón de siempre y el OAuth funciona.
- Conectar Google Calendar desde `/hours` sigue funcionando.
