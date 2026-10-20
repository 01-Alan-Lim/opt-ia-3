// src/app/chat/_lib/useChatSession.ts
//
// Sesión de Supabase Auth en el cliente del chat: lee la sesión inicial, sigue onAuthStateChange
// y arma el header Authorization. NO autoriza: la identidad, el rol y la cohorte los resuelve el
// servidor con el Bearer (/api/me y cada ruta de API). userId y email son datos de UI y de las
// claves de storage, nunca autoridad. Se movió tal cual desde page.tsx. accountName es el nombre
// de la cuenta de Google: el chat muestra el del perfil (/api/me) y usa este solo si falta.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export function useChatSession() {
  // -----------------------------
  // Auth (Supabase)
  // -----------------------------
  const [ready, setReady] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionFullName, setSessionFullName] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  // Mantiene el estado de sesión actualizado
  useEffect(() => {
    let active = true;

    async function loadSession() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;

      setSessionEmail(data.session?.user?.email ?? null);
      setUserId(data.session?.user?.id ?? null);
      setAccessToken(data.session?.access_token ?? null);

      const meta = data.session?.user?.user_metadata as Record<string, unknown> | undefined;
      const full =
        (typeof meta?.full_name === "string" && meta.full_name.trim()) ||
        (typeof meta?.name === "string" && meta.name.trim()) ||
        null;

      setSessionFullName(full);
      setReady(true);
    }

    loadSession();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSessionEmail(newSession?.user?.email ?? null);
      setUserId(newSession?.user?.id ?? null);
      setAccessToken(newSession?.access_token ?? null);

      const meta = (newSession?.user?.user_metadata ?? {}) as Record<string, unknown>;
      const full =
        (typeof meta.full_name === "string" && meta.full_name.trim()) ||
        (typeof meta.name === "string" && meta.name.trim()) ||
        null;

      setSessionFullName(full);
      setReady(true);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const authenticated = useMemo(() => Boolean(userId), [userId]);

  async function getAuthHeaders(): Promise<Record<string, string>> {
    if (accessToken) return { Authorization: `Bearer ${accessToken}` };

    // Fallback por seguridad
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  return {
    ready,
    sessionEmail,
    userId,
    accessToken,
    authenticated,
    accountName: sessionFullName,
    getAuthHeaders,
  };
}
