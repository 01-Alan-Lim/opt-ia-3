// src/proxy.ts

// Protección server-side de páginas. (Next 16 llama "proxy" a lo que antes era middleware.ts;
// corre siempre en Node.js y no admite `runtime` en config.)
//
// QUÉ HACE HOY
//   Bloquea /dev/* fuera de desarrollo. La página /dev/index-pdf no tenía ninguna guarda
//   (las rutas /api/dev/* sí la tienen: NODE_ENV === "production" -> FORBIDDEN_IN_PRODUCTION).
//
// QUÉ NO PUEDE HACER TODAVÍA, Y POR QUÉ
//   Exigir sesión en /chat, /hours y /onboarding, o rol docente en /docente, necesita que el
//   servidor pueda leer la sesión de la petición. Hoy no puede: la sesión de Supabase se
//   guarda en localStorage del navegador (createClient de @supabase/supabase-js sin
//   almacenamiento en cookies; no está @supabase/ssr) y todas las rutas de API autentican
//   con la cabecera Authorization: Bearer. La petición de navegación que llega aquí NO
//   lleva ninguna credencial, así que un gate de sesión en este archivo redirigiría al 100%
//   de los usuarios legítimos, incluidos los que sí tienen sesión.
//
//   Para habilitarlo hace falta primero mover la sesión a cookies (@supabase/ssr con
//   createServerClient). Mientras tanto, esas páginas siguen protegidas por dos vías: la
//   redirección del cliente y, sobre todo, que no traen datos en el HTML — todo su
//   contenido lo piden a rutas de API que sí exigen Bearer y validan rol, propiedad y
//   cohorte en el servidor.

import { NextRequest, NextResponse } from "next/server";

// Prefijos de páginas que solo existen en desarrollo.
const DEV_ONLY_PREFIXES = ["/dev"] as const;

function isDevOnlyPath(pathname: string): boolean {
  return DEV_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Fuera de desarrollo, /dev/* no existe. 404 en vez de 403: no confirma que la ruta esté
  // ahí. Misma condición que usan las rutas /api/dev/*.
  if (isDevOnlyPath(pathname) && process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  return NextResponse.next();
}

// Se excluyen los assets y las rutas de API. Las rutas públicas (/, /auth/*, /privacy,
// /terms, /access-expired, /landing-lab) pasan por aquí y no se tocan: el único bloqueo es
// el de /dev/*.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|webmanifest)$).*)"],
};
