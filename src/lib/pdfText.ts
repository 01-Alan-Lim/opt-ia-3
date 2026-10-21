// src/lib/pdfText.ts

type PdfParseResult = {
  text?: string;
  numpages?: number;
};

type PdfParseFn = (
  dataBuffer: Buffer | Uint8Array,
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

// Lo que pdf-parse le pasa a pagerender (un PDFPageProxy de pdf.js 1.10).
type PdfTextItem = { str: string; transform: number[] };
type PdfPageData = {
  pageIndex: number;
  getTextContent(options: Record<string, unknown>): Promise<{ items: PdfTextItem[] }>;
};

const letterCount = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "").length;

// Texto y cantidad de páginas de un PDF para la Biblioteca Académica, con los saltos de línea que
// da pdf-parse (extractTextFromPDF los aplana). El pdf.js 1.10 de pdf-parse lee mal un Buffer de
// Node: responde "bad XRef entry" aunque el PDF sea válido. Con un Uint8Array común lo lee bien,
// así que se le pasa una copia de ese tipo. maxPages limita las páginas que se leen; pages es el
// total del documento. pageLetters: letras y dígitos de cada página leída (0 si pdf-parse no pudo
// leerla: la deja vacía sin avisar). Para contarlas, pagerender repite el render_page de pdf-parse
// 1.1.x tal cual, así que el texto es el mismo que sin él.
export async function extractPdfContent(
  bytes: Uint8Array,
  options: { maxPages?: number } = {}
): Promise<{ text: string; pages: number; pageLetters: number[] }> {
  const pdfParse = await getPdfParse();
  const letters: number[] = [];
  const result = await pdfParse(Uint8Array.from(bytes), {
    max: options.maxPages ?? 0,
    pagerender: async (pageData: PdfPageData) => {
      const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY: number | undefined;
      let text = "";
      for (const item of content.items) {
        text += lastY === item.transform[5] || !lastY ? item.str : `\n${item.str}`;
        lastY = item.transform[5];
      }
      letters[pageData.pageIndex] = letterCount(text);
      return text;
    },
  });
  const pages = typeof result.numpages === "number" ? result.numpages : 0;
  const read = options.maxPages && options.maxPages > 0 ? Math.min(pages, options.maxPages) : pages;
  return {
    text: result.text ?? "",
    pages,
    pageLetters: Array.from({ length: read }, (_, index) => letters[index] ?? 0),
  };
}

export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  const pdfParse = await getPdfParse();
  const result = await pdfParse(buffer);

  return (result.text ?? "")
    .replace(/\s+\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}