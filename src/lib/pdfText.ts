// src/lib/pdfText.ts

type PdfParseResult = {
  text?: string;
};

type PdfParseFn = (
  dataBuffer: Buffer,
  options?: Record<string, unknown>
) => Promise<PdfParseResult>;

let pdfParsePromise: Promise<PdfParseFn> | null = null;

async function getPdfParse(): Promise<PdfParseFn> {
  if (!pdfParsePromise) {
    pdfParsePromise = import("pdf-parse").then((mod) => {
      const candidate = "default" in mod ? mod.default : mod;

      if (typeof candidate !== "function") {
        throw new Error("No se pudo cargar pdf-parse correctamente.");
      }

      return candidate as PdfParseFn;
    });
  }

  return pdfParsePromise;
}

export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  const pdfParse = await getPdfParse();
  const result = await pdfParse(buffer);

  return (result.text ?? "")
    .replace(/\s+\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}