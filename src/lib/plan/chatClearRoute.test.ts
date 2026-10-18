import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// POST /api/chats/[chatId]/clear está desactivado: responde 410 y no toca la base.
// Importar la ruta sin variables de Supabase ya comprueba que no carga el cliente de service
// role (supabaseServer falla al importarse sin NEXT_PUBLIC_SUPABASE_URL); además se revisa
// el código de la ruta, sin comentarios, por si el entorno sí tuviera esas variables.
import { POST } from "../../app/api/chats/[chatId]/clear/route";

const ROUTE_FILE = path.join("src", "app", "api", "chats", "[chatId]", "clear", "route.ts");

async function main() {
  const res = await POST();
  assert.equal(res.status, 410);
  assert.deepEqual(await res.json(), {
    ok: false,
    code: "GONE",
    message: "El historial de un chat no se puede borrar.",
  });

  const code = readFileSync(ROUTE_FILE, "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/supabase/i.test(code), "la ruta no debe usar Supabase");
  assert.ok(!/\.delete\(/.test(code), "la ruta no debe borrar nada");
}

main()
  .then(() => console.log("chatClearRoute tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
