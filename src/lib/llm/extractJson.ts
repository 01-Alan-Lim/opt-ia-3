// src/lib/llm/extractJson.ts

function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function tryJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapQuotedJsonString(text: string): string {
  const trimmed = text.trim();

  if (!trimmed) return trimmed;

  const looksQuoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));

  if (!looksQuoted) return trimmed;

  const parsed = tryJsonParse(trimmed);
  if (typeof parsed === "string") {
    return parsed.trim();
  }

  return trimmed;
}

function extractBalancedJsonBlock(text: string): string | null {
  const startCandidates = [text.indexOf("{"), text.indexOf("[")]
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b);

  if (startCandidates.length === 0) return null;

  const start = startCandidates[0];
  const opening = text[start];
  const closing = opening === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === opening) depth++;
    if (ch === closing) depth--;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

function buildCandidates(raw: string): string[] {
  const base = raw
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .trim();

  const candidates: string[] = [];

  const add = (value: string) => {
    const v = value.trim();
    if (v && !candidates.includes(v)) candidates.push(v);
  };

  add(base);

  const noFence = stripCodeFences(base);
  add(noFence);

  const unwrapped = unwrapQuotedJsonString(noFence);
  add(unwrapped);

  const unwrappedNoFence = stripCodeFences(unwrapped);
  add(unwrappedNoFence);

  const balanced = extractBalancedJsonBlock(unwrappedNoFence);
  if (balanced) add(balanced);

  return candidates;
}

export function extractJsonSafe(raw: string): unknown | null {
  if (!raw || !raw.trim()) return null;

  const candidates = buildCandidates(raw);

  for (const candidate of candidates) {
    const parsed = tryJsonParse(candidate);
    if (parsed !== null) return parsed;

    const balanced = extractBalancedJsonBlock(candidate);
    if (!balanced) continue;

    const parsedBalanced = tryJsonParse(balanced);
    if (parsedBalanced !== null) return parsedBalanced;
  }

  return null;
}