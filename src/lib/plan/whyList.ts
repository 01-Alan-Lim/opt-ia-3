// src/lib/plan/whyList.ts

// Fusión de las listas de porqués de una subcausa (Ishikawa E4). Lógica pura, sin I/O.
// La usa la capa de persistencia (ishikawa/state) al guardar el estado.

// Texto de un porqué guardado: string, o { text } / { id } en estados antiguos.
export function whyToKey(why: unknown): string {
  if (typeof why === "string") return why.trim();

  if (why && typeof why === "object") {
    const record = why as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    const id = typeof record.id === "string" ? record.id.trim() : "";
    return text || id;
  }

  return "";
}

// Une base + incoming sin duplicados (comparando en minúsculas), conserva el orden y
// recorta a los PRIMEROS maxKeep. Una entrada que no es lista cuenta como vacía.
export function dedupeWhys(base: unknown, incoming: unknown, maxKeep: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (why: unknown) => {
    const key = whyToKey(why);
    if (!key) return;

    const normalized = key.toLowerCase();
    if (seen.has(normalized)) return;

    seen.add(normalized);
    out.push(key);
  };

  for (const why of Array.isArray(base) ? base : []) push(why);
  for (const why of Array.isArray(incoming) ? incoming : []) push(why);

  return out.length > maxKeep ? out.slice(0, maxKeep) : out;
}

// Subcausa fusionada: gana incoming campo a campo y los porqués se deduplican y recortan.
// - Sin flag: los porqués entrantes se UNEN con los guardados (un estado incompleto no
//   borra porqués).
// - incoming.whysReplace === true: la lista entrante es autoritativa (reemplazo explícito
//   de un porqué) y no se une con la guardada.
// El flag whysReplace nunca se persiste.
export function mergeSubCause(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  maxKeep: number
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...incoming };
  const incomingWhys = Array.isArray(incoming.whys) ? incoming.whys : base.whys;

  merged.whys =
    incoming.whysReplace === true
      ? dedupeWhys([], incomingWhys, maxKeep)
      : dedupeWhys(base.whys, incomingWhys, maxKeep);

  delete merged.whysReplace;
  return merged;
}
