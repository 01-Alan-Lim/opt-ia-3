// src/app/chat/_lib/useAccessGate.ts
//
// Access gate del chat: redirige si no hay sesión y consulta /api/me, que es la fuente de verdad
// (rol, onboarding, aprobación, cohorte, ventana de acceso). El cliente solo aplica lo que responde
// el servidor: navegación, mensaje y modo solo lectura. No decide roles ni cohortes ni consulta
// tablas. Se movió tal cual desde page.tsx; page.tsx sigue decidiendo qué pantalla mostrar.
// También expone el nombre del perfil y el rol que trae /api/me (identity), para la cabecera y el
// saludo (studentIdentity.ts): solo para mostrar, no autoriza nada.

import { useEffect, useState } from "react";
import type { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { readMeIdentity, type MeIdentity } from "@/lib/chat/studentIdentity";

type GateReason =
  | "OK"
  | "NEEDS_ONBOARDING"
  | "PENDING_APPROVAL"
  | "COHORT_INACTIVE"
  | "ACCESS_NOT_STARTED"
  | "ACCESS_EXPIRED";

type ChatRouter = ReturnType<typeof useRouter>;

// Se cumple una sola vez, cuando /api/me respondió (con la identidad) o falló (null).
function createIdentityWait() {
  let resolve: (identity: MeIdentity | null) => void = () => undefined;
  const promise = new Promise<MeIdentity | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function useAccessGate({
  ready,
  authenticated,
  router,
}: {
  ready: boolean;
  authenticated: boolean;
  router: ChatRouter;
}) {
  // Gate final (solo /api/me)
  const [gateChecked, setGateChecked] = useState(false);
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [canInteract, setCanInteract] = useState(true); // false => solo lectura
  // Nombre del perfil y rol de /api/me; null hasta que responde, o si falla.
  const [identity, setIdentity] = useState<MeIdentity | null>(null);
  // La apertura de E0 la espera para saludar con el nombre del perfil y no con uno provisional.
  const [identityWait] = useState(createIdentityWait);

  // -----------------------------
  // Redirect si no está autenticado
  // -----------------------------
  useEffect(() => {
    if (ready && !authenticated) {
      router.replace("/");
    }
  }, [ready, authenticated, router]);

  // -----------------------------
  // Gate final del chat (FUENTE DE VERDAD: /api/me)
  // -----------------------------
  useEffect(() => {
    if (!ready || !authenticated) return;

    let active = true;

    (async () => {
      try {
        setGateChecked(false);

        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) {
          if (!active) return;
          identityWait.resolve(null);
          setGateChecked(true);
          return;
        }

        const res = await fetch("/api/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        const json = await res.json().catch(() => null);
        const isOk = res.ok && json?.ok !== false;
        const payload = isOk ? (json?.data ?? json) : null;

        if (!active) return;

        const me = payload ? readMeIdentity(payload) : null;
        setIdentity(me);
        identityWait.resolve(me);

        // defaults
        setAccessDenied(false);
        setCanInteract(true);
        setGateMessage(null);

        // Si /api/me falla, manejamos 401/403 explícitamente
        if (!payload) {
          // 401: token inválido / sesión muerta => cerrar sesión y volver al home
          if (res.status === 401) {
            await supabase.auth.signOut();
            setGateChecked(true);
            router.replace("/");
            return;
          }

          // 403: correo no autorizado
          if (res.status === 403) {
            await supabase.auth.signOut(); // 🔥 importante: evita que "recuerde" la sesión
            setAccessDenied(true);
            setCanInteract(false);
            setGateMessage(
              "Acceso restringido. Debes iniciar sesión con un correo institucional autorizado."
            );
            setGateChecked(true);
            router.replace("/?reason=forbidden");
            return;
          }

          // Otros fallos: no bloqueamos, pero marcamos gate como chequeado
          setGateChecked(true);
          return;
        }

        // ✅ /api/me => { user, profile, gates }
        const role = (payload?.user?.role ?? "student") as "student" | "teacher";
        if (role === "teacher") {
          setGateChecked(true);
          router.replace("/docente");
          return;
        }

        const reason = (payload?.gates?.reason ?? null) as GateReason | null;

        if (!reason) {
          setGateChecked(true);
          return;
        }

        if (reason === "NEEDS_ONBOARDING") {
          setGateChecked(true);
          router.replace("/onboarding");
          return;
        }

        if (reason === "PENDING_APPROVAL") {
          setCanInteract(false);
          setGateMessage(
            "Tu registro fue enviado y está pendiente de aprobación del docente."
          );
          setGateChecked(true);
          return;
        }

        if (reason === "COHORT_INACTIVE") {
          setCanInteract(false);
          setGateMessage(
            "Tu cohorte está inactiva. Puedes ver tu historial, pero no enviar mensajes."
          );
          setGateChecked(true);
          return;
        }

        if (reason === "ACCESS_NOT_STARTED") {
          setCanInteract(false);
          setGateMessage(
            "Tu acceso aún no ha iniciado. Puedes ver tu historial, pero no enviar mensajes."
          );
          setGateChecked(true);
          return;
        }

        if (reason === "ACCESS_EXPIRED") {
          setCanInteract(false);
          setGateMessage(
            "Tu acceso al asistente ha finalizado. Puedes ver tu historial, pero no enviar mensajes."
          );
          setGateChecked(true);
          return;
        }

        setGateChecked(true);
      } catch (e) {
        if (!active) return;
        console.error("Chat gate (/api/me) failed:", e);
        identityWait.resolve(null);
        setGateChecked(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, router, identityWait]);

  return {
    gateChecked,
    gateMessage,
    accessDenied,
    canInteract,
    identity,
    whenIdentityKnown: () => identityWait.promise,
  };
}
