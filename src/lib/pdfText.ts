// src/lib/pdfText.ts

import * as pdfjsLib from "pdfjs-dist";

// En entorno Node (como tus API routes de Next.js) no es necesario configurar workerSrc

export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  // Cargar el PDF desde un Buffer
  const loadingTask = (pdfjsLib as any).getDocument({ data: buffer });
  const pdf = await loadingTask.promise;

  let fullText = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    const pageText = textContent.items
      .map((item: any) => {
        if ("str" in item) return item.str;
        return "";
      })
      .join(" ");

    fullText += pageText + "\n";
  }

  return fullText;
}
