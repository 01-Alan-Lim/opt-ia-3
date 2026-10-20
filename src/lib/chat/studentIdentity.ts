// src/lib/chat/studentIdentity.ts
//
// Nombre del estudiante. getPreferredStudentFirstName es el que usan las rutas de E1-E10 en el
// servidor (sin cambios). describeChatIdentity es el que muestra el chat (cabecera y saludo de E0);
// ver "Nombre para mostrar en el chat" más abajo.

export type StudentIdentityInput = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
};

function cleanToken(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function getPreferredStudentFirstName(
  input: StudentIdentityInput
): string | null {
  const firstName = cleanToken(input.firstName);

  if (firstName) {
    const firstToken = firstName.split(" ").filter(Boolean)[0] ?? "";
    return firstToken || null;
  }

  const email = cleanToken(input.email);
  if (!email || !email.includes("@")) return null;

  const localPart = email.split("@")[0]?.trim() ?? "";
  if (!localPart) return null;

  const normalized = localPart
    .replace(/[._-]+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const firstToken = normalized.split(" ").filter(Boolean)[0] ?? "";
  return firstToken || null;
}

export function sanitizeStudentPlaceholder(
  message: string,
  preferredFirstName: string | null
): string {
  let text = String(message ?? "").trim();

  const placeholderRegex =
    /\[(?:nombre del estudiante|nombre estudiante|nombre|student name|student)\]/gi;

  if (preferredFirstName) {
    text = text.replace(placeholderRegex, preferredFirstName);
  } else {
    text = text.replace(placeholderRegex, "");
  }

  return text
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\s+!/g, "!")
    .replace(/\s+\?/g, "?")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------- Nombre para mostrar en el chat ----------------
// Fuente principal: el perfil (profiles.first_name y last_name) que devuelve /api/me, que resuelve
// al usuario en el servidor con la sesión; nunca un userId del cliente. Aquí solo se da formato
// para mostrar: lo guardado en el perfil no cambia. Sin perfil, el nombre de la cuenta de Google;
// sin ninguno de los dos, ningún nombre (no se arma uno a partir del correo).

// Lo que el chat toma de la respuesta de /api/me ({ user, profile, gates }).
export type MeIdentity = { firstName: string | null; lastName: string | null; role: string | null };

export function readMeIdentity(payload: unknown): MeIdentity | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as {
    user?: { role?: unknown } | null;
    profile?: { first_name?: unknown; last_name?: unknown } | null;
  };
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  return {
    firstName: text(data.profile?.first_name),
    lastName: text(data.profile?.last_name),
    role: text(data.user?.role),
  };
}

// Van en minúscula dentro de un nombre: "María de los Ángeles", "Alan de la Cruz".
const NAME_PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "e", "da", "das", "do", "dos", "di", "van", "von"]);
// Primera palabra de apellidos compuestos: "San Martín", "Santa Cruz".
const SURNAME_PREFIXES = new Set(["san", "santa", "santo"]);
// Nombres de pila que suelen ir con el siguiente ("María José", "José Luis", "Juan Carlos",
// "Ana María", "Luis Fernando", "Miguel Ángel"): se muestran juntos. Los demás nombres muestran
// solo el primero ("Alan Mauricio" -> "Alan").
const COMPOUND_GIVEN_NAMES = new Set(["maria", "jose", "juan", "ana", "luis", "miguel"]);

function foldName(word: string) {
  return word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function nameWords(raw: string | null | undefined) {
  return String(raw ?? "").normalize("NFC").trim().split(/\s+/).filter(Boolean);
}

// Una palabra del nombre: si viene toda en mayúsculas o toda en minúsculas, mayúscula inicial
// (también tras guion o apóstrofo: "Ana-Lucía", "O'Connor"); si trae mayúsculas internas a
// propósito ("McDonald"), queda como está. Las partículas van en minúscula salvo al comienzo.
function formatNameWord(word: string, first: boolean) {
  const lower = word.toLocaleLowerCase("es");
  if (!first && NAME_PARTICLES.has(foldName(word))) return lower;
  if (word !== lower && word !== word.toLocaleUpperCase("es")) return word;
  return lower.replace(/(^|[-'’])(\p{L})/gu, (_, separator: string, letter: string) => separator + letter.toLocaleUpperCase("es"));
}

function formatNameWords(words: string[]) {
  return words.map((word, index) => formatNameWord(word, index === 0)).join(" ");
}

// Un nombre completo con formato de presentación, sin recortarlo: "MARÍA JOSÉ" -> "María José".
export function formatPersonName(raw: string | null | undefined) {
  return formatNameWords(nameWords(raw));
}

// El nombre de pila con el que se saluda: el primero, o los dos de un nombre compuesto.
export function primaryGivenName(raw: string | null | undefined): string | null {
  const words = nameWords(raw);
  if (words.length === 0) return null;
  let count = 1;
  if (words.length > 1 && COMPOUND_GIVEN_NAMES.has(foldName(words[0]))) {
    // "María de los Ángeles": las partículas se llevan la palabra que sigue.
    while (count < words.length && NAME_PARTICLES.has(foldName(words[count]))) count += 1;
    count = Math.min(count + 1, words.length);
  }
  return formatNameWords(words.slice(0, count));
}

// El primer apellido, con sus partículas: "Limachi Mamani" -> "Limachi", "De La Cruz Quispe" ->
// "de la Cruz", "San Martín López" -> "San Martín".
export function primarySurname(raw: string | null | undefined): string | null {
  const words = nameWords(raw);
  if (words.length === 0) return null;
  let count = 0;
  while (
    count < words.length - 1 &&
    (NAME_PARTICLES.has(foldName(words[count])) || SURNAME_PREFIXES.has(foldName(words[count])))
  ) {
    count += 1;
  }
  // La partícula inicial de un apellido va en minúscula detrás del nombre ("Alan de la Cruz").
  return words
    .slice(0, count + 1)
    .map((word) => formatNameWord(word, SURNAME_PREFIXES.has(foldName(word))))
    .join(" ");
}

export type ChatIdentity = {
  // Para saludar: el nombre de pila ("Alan", "María José"); null si no se conoce.
  greetingName: string | null;
  // Para la cabecera: "Univ. Alan Limachi" para un estudiante y "Alan Limachi" para otro rol o si
  // el rol no se conoce; sin nombre, el correo de la sesión o nada.
  headerName: string;
};

export function describeChatIdentity(input: {
  firstName?: string | null;
  lastName?: string | null;
  // user.role de /api/me: "Univ." solo para "student".
  role?: string | null;
  // Nombre de la cuenta de Google (metadatos de Supabase Auth): solo si falta el perfil.
  accountName?: string | null;
  email?: string | null;
}): ChatIdentity {
  const prefix = input.role === "student" ? "Univ. " : "";
  const given = primaryGivenName(input.firstName);
  const surname = primarySurname(input.lastName);

  if (given || surname) {
    const name = [given, surname].filter(Boolean).join(" ");
    return { greetingName: given, headerName: prefix + name.charAt(0).toUpperCase() + name.slice(1) };
  }

  const account = formatPersonName(input.accountName);
  if (account) return { greetingName: primaryGivenName(input.accountName), headerName: prefix + account };

  return { greetingName: null, headerName: String(input.email ?? "").trim() };
}