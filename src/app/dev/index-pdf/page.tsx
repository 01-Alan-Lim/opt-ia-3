"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function DevIndexPdfPage() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("Guía 14.1 Balanceo de línea");
  const [description, setDescription] = useState(
    "Guía real de balanceo de línea para MyPEs"
  );
  const [path, setPath] = useState("mypes/GUIA_14.1_BALANCEO_DE_LINEA.pdf");
  const [status, setStatus] = useState<string>("Sin acciones aún.");
  const [loading, setLoading] = useState(false);

  // 👇 pdfjs se carga solo en el navegador
  const [pdfjsLib, setPdfjsLib] = useState<any | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod: any = await import("pdfjs-dist");
        // worker desde /public/pdf.worker.min.js
        mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
        if (!cancelled) {
          setPdfjsLib(mod);
        }
      } catch (err) {
        console.error("Error cargando pdfjs-dist:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f) {
      setPath(`mypes/${f.name}`);
      if (!title || title === "Guía 14.1 Balanceo de línea") {
        setTitle(f.name);
      }
    }
  };

  // Extraer texto de un File usando pdfjs-dist en el navegador
  const extractTextFromPdfFile = async (file: File): Promise<string> => {
    if (!pdfjsLib) {
      throw new Error("La librería PDF aún se está cargando.");
    }

    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
    const pdf = await loadingTask.promise;

    let fullText = "";

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      const pageText = (textContent.items as any[])
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");

      fullText += "\n" + pageText;
    }

    return fullText;
  };

  const handleIndex = async () => {
    try {
      if (!file) {
        setStatus("Selecciona un PDF primero.");
        return;
      }
      if (!pdfjsLib) {
        setStatus("La librería de PDF aún se está cargando. Espera un momento.");
        return;
      }

      setLoading(true);
      setStatus("Subiendo PDF a Supabase...");

      // 1) Subir el PDF al bucket documents
      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(path, file, {
          upsert: true,
        });

      if (uploadError) {
        console.error("Error al subir el PDF:", uploadError);
        setStatus("Error al subir el PDF a Supabase.");
        setLoading(false);
        return;
      }

      setStatus("Extrayendo texto del PDF en el navegador...");

      // 2) Extraer texto con pdfjs-dist (en el cliente)
      const fullText = await extractTextFromPdfFile(file);

      if (!fullText.trim()) {
        setStatus("El PDF no contiene texto extraíble.");
        setLoading(false);
        return;
      }

      setStatus("Enviando texto al backend para indexar...");

      // 3) Enviar texto al backend para crear documento + chunks + embeddings
      const res = await fetch("/api/dev/index-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          title,
          description,
          text: fullText,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        console.error("Error desde /api/dev/index-pdf:", data);
        setStatus("Error al indexar el texto: " + (data.error || "desconocido"));
      } else {
        console.log("Indexación OK:", data);
        setStatus(
          `✅ Indexado correctamente. documentId=${data.documentId}, chunks=${data.chunksCount}`
        );
      }
    } catch (err) {
      console.error("Error en handleIndex:", err);
      setStatus("Error inesperado. Revisa la consola.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-xl border border-slate-700 rounded-xl p-6 bg-slate-900/80">
        <h1 className="text-xl font-semibold mb-4">
          Dev · Subir e indexar PDF (Supabase + RAG)
        </h1>

        <label className="block mb-3 text-sm">
          Archivo PDF
          <input
            type="file"
            accept="application/pdf"
            onChange={handleFileChange}
            className="mt-1 block w-full text-sm text-slate-200"
          />
        </label>

        <label className="block mb-3 text-sm">
          Path en bucket <code>documents</code>
          <input
            className="mt-1 w-full rounded-md bg-slate-800 border border-slate-600 px-2 py-1 text-sm"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>

        <label className="block mb-3 text-sm">
          Título
          <input
            className="mt-1 w-full rounded-md bg-slate-800 border border-slate-600 px-2 py-1 text-sm"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="block mb-4 text-sm">
          Descripción
          <textarea
            className="mt-1 w-full rounded-md bg-slate-800 border border-slate-600 px-2 py-1 text-sm"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <button
          onClick={handleIndex}
          disabled={loading}
          className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-60"
        >
          {loading ? "Procesando..." : "Subir e indexar"}
        </button>

        <div className="mt-4 text-sm text-slate-300 whitespace-pre-line">
          {status}
        </div>
      </div>
    </main>
  );
}
