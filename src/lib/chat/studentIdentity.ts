// src/lib/chat/studentIdentity.ts

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