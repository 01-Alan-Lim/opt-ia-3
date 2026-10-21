"use client";

// Biblioteca Académica del panel docente (pestaña Biblioteca). Lista los documentos globales del
// RAG con formato, estado, fecha y fragmentos (GET /api/teacher/library), los filtra en el
// navegador y permite subir un PDF digital o un DOCX (POST /api/teacher/library). Las guías que ya
// están en Storage se reindexan sin subirlas (POST /api/teacher/library/:id/reindex), de a una o
// todas las pendientes en fila. El procesamiento corre por pasos
// (POST /api/teacher/library/:id/process) y el panel los encadena, con el progreso a la vista; un
// documento interrumpido o fallido se continúa desde la lista. Todo documento listo (subido o
// reindexado) queda inactivo hasta que el docente lo active (PATCH /api/teacher/library); el
// asistente solo usa los activos. Todo lo decide el servidor (solo docentes): aquí solo se manda
// el token de la sesión y se pinta lo que responde.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  countByStatus,
  DEFAULT_LIBRARY_FILTERS,
  describeChunks,
  describeExtraction,
  filterLibraryDocuments,
  isDefaultLibraryFilters,
  LIBRARY_DISPLAY_LABEL,
  LIBRARY_FILE_TYPE_LABEL,
  LIBRARY_STATUS_LABEL,
  LIBRARY_STATUSES,
  LIBRARY_UPLOAD_ACCEPT,
  libraryDisplayState,
  needsReindex,
  pendingReindexQueue,
  readActivationResponse,
  readLibraryErrorMessage,
  readLibraryResponse,
  readProcessResponse,
  readReindexResponse,
  readUploadResponse,
  uploadCandidateProblem,
  type LibraryAvailabilityFilter,
  type LibraryDisplayState,
  type LibraryDocument,
  type LibraryExtractionReport,
  type LibraryFilters,
  type LibraryStatusFilter,
} from "@/lib/teacher/library/catalog";

type PanelState =
  | { status: "loading" }
  | { status: "ready"; documents: LibraryDocument[] }
  | { status: "denied" }
  | { status: "error"; message: string };

// Resultado de "Reindexar pendientes", documento por documento.
type BatchSummary = {
  count: number;
  ready: Array<{ title: string; total: number; warnings: string[] }>;
  failed: Array<{ title: string; message: string }>;
  stopped: { title: string; message: string } | null;
};

// Subida, reindexación y procesamiento en curso (uno a la vez). label: "Documento 3 de 10" en una
// reindexación en fila.
type Job =
  | { phase: "idle" }
  | { phase: "uploading"; fileName: string }
  | {
      phase: "processing";
      title: string;
      processed: number;
      total: number;
      waiting: boolean;
      label: string | null;
      extraction: LibraryExtractionReport | null;
    }
  | { phase: "done"; title: string; total: number; active: boolean; extraction: LibraryExtractionReport | null }
  | { phase: "stopped"; title: string; message: string }
  | { phase: "error"; title: string | null; message: string }
  | { phase: "batch"; summary: BatchSummary }
  | { phase: "notice"; tone: "success" | "error"; message: string };

// Cómo terminó un documento: listo; fallido (un problema de ese documento: en una fila se sigue
// con el siguiente); o detenido (conexión, límite de Gemini, sesión o error del servidor: la fila
// se detiene y se retoma después, sin perder lo guardado).
type RunOutcome =
  | { kind: "done"; total: number; active: boolean; extraction: LibraryExtractionReport | null }
  | { kind: "failed"; message: string }
  | { kind: "stopped"; message: string };

// Pasos máximos por corrida y esperas seguidas por límite de Gemini antes de dejarlo para después.
const MAX_STEPS = 40;
const MAX_RATE_LIMIT_WAITS = 4;
const MAX_WAIT_MS = 30_000;

const STATE_DOT: Record<LibraryDisplayState, string> = {
  pending: "bg-amber-400/80",
  processing: "bg-sky-400/80",
  failed: "bg-rose-400/80",
  ready_inactive: "bg-slate-400/80",
  active: "bg-emerald-400/80",
  active_stale: "bg-amber-400/80",
};

// Columnas de la tabla en pantallas medianas o más grandes; en móvil cada fila es una tarjeta.
const ROW_GRID = "md:grid md:grid-cols-[minmax(0,1fr)_4.5rem_10rem_13rem_6.5rem] md:items-center md:gap-4";

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("es-BO", { day: "2-digit", month: "short", year: "numeric" });
}

// Una respuesta de error que no es de un documento en particular (sesión, permisos, servidor).
const isSystemicFailure = (status: number) => status >= 500 || status === 401 || status === 403;

type ReindexStart =
  | { kind: "started"; total: number; extraction: LibraryExtractionReport | null }
  | Exclude<RunOutcome, { kind: "done" }>;

// Reclama un documento pending para reindexarlo. No genera embeddings: después vienen los pasos.
async function requestReindex(documentId: string): Promise<ReindexStart> {
  let res: Response;
  let json: unknown;
  try {
    res = await fetch(`/api/teacher/library/${encodeURIComponent(documentId)}/reindex`, {
      method: "POST",
      headers: await authHeaders(),
    });
    json = await res.json().catch(() => null);
  } catch {
    return { kind: "stopped", message: "Se perdió la conexión antes de empezar." };
  }
  const data = res.ok ? readReindexResponse(json) : null;
  if (!data) {
    const message = readLibraryErrorMessage(json) ?? "No se pudo empezar la reindexación.";
    return isSystemicFailure(res.status) ? { kind: "stopped", message } : { kind: "failed", message };
  }
  return { kind: "started", total: data.totalChunks ?? 0, extraction: data.extraction };
}

function finalJob(outcome: RunOutcome, title: string): Job {
  if (outcome.kind === "done") {
    return { phase: "done", title, total: outcome.total, active: outcome.active, extraction: outcome.extraction };
  }
  if (outcome.kind === "failed") return { phase: "error", title, message: outcome.message };
  return { phase: "stopped", title, message: outcome.message };
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="text-lg font-semibold text-slate-100">{value}</dd>
    </div>
  );
}

// Lo que se extrajo, sin prometer más: solo se lee el texto digital del archivo.
function ExtractionNote({ extraction }: { extraction: LibraryExtractionReport | null }) {
  if (!extraction) return null;
  return (
    <>
      <p className="mt-1 text-xs text-slate-400">
        Texto digital extraído: {describeExtraction(extraction)}. Las imágenes, los diagramas y las páginas escaneadas
        no se leen.
      </p>
      {extraction.warnings.map((warning) => (
        <p key={warning} className="mt-1 text-xs text-amber-300">
          {warning}
        </p>
      ))}
    </>
  );
}

function BatchStatus({ summary }: { summary: BatchSummary }) {
  const { count, ready, failed, stopped } = summary;
  const warned = ready.filter((item) => item.warnings.length > 0);
  return (
    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 text-sm">
      <p className="text-slate-200">
        Reindexación: {ready.length} de {count} {count === 1 ? "documento quedó listo" : "documentos quedaron listos"}.
        {ready.length > 0 && " Quedan inactivos: revísalos y actívalos desde la lista para que OPT-IA los use."}
      </p>
      {warned.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-amber-300">
          {warned.map((item) => (
            <li key={item.title}>
              «{item.title}»: {item.warnings.join(" ")}
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-rose-300">
          {failed.map((item) => (
            <li key={item.title}>
              «{item.title}»: {item.message}
            </li>
          ))}
        </ul>
      )}
      {stopped && (
        <p className="mt-2 text-xs text-amber-300">
          Se detuvo en «{stopped.title}»: {stopped.message} Lo ya guardado se conserva: vuelve a «Reindexar pendientes» para
          seguir desde ahí.
        </p>
      )}
    </div>
  );
}

function JobStatus({ job }: { job: Job }) {
  if (job.phase === "idle") return null;

  if (job.phase === "uploading" || job.phase === "processing") {
    const percent = job.phase === "processing" && job.total > 0 ? Math.round((job.processed / job.total) * 100) : null;
    return (
      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3">
        {job.phase === "processing" && job.label && <p className="text-[11px] text-slate-500">{job.label}</p>}
        <p className="text-sm text-slate-200">
          {job.phase === "uploading"
            ? `Subiendo y revisando «${job.fileName}»…`
            : job.total > 0
              ? `Procesando «${job.title}»: ${job.processed} de ${job.total} fragmentos`
              : `Preparando «${job.title}»…`}
        </p>
        {job.phase === "processing" && <ExtractionNote extraction={job.extraction} />}
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
          <div
            className={`h-full rounded-full bg-sky-500/80 transition-[width] duration-500 ${percent === null ? "w-1/3 animate-pulse" : ""}`}
            style={percent === null ? undefined : { width: `${Math.max(percent, 3)}%` }}
          />
        </div>
        {job.phase === "processing" && job.waiting && (
          <p className="mt-2 text-xs text-amber-300">Gemini pidió esperar un momento; se reintenta solo.</p>
        )}
        <p className="mt-2 text-[11px] text-slate-500">No cierres esta pestaña hasta que termine.</p>
      </div>
    );
  }

  if (job.phase === "batch") return <BatchStatus summary={job.summary} />;

  if (job.phase === "notice") {
    return (
      <p
        className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
          job.tone === "success"
            ? "border-emerald-800/60 bg-emerald-950/20 text-emerald-200"
            : "border-rose-800/60 bg-rose-950/20 text-rose-200"
        }`}
      >
        {job.message}
      </p>
    );
  }

  if (job.phase === "done") {
    return (
      <div className="mt-3 rounded-xl border border-emerald-800/60 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-200">
        <p>
          «{job.title}» quedó listo: {job.total} {job.total === 1 ? "fragmento" : "fragmentos"}.{" "}
          {job.active
            ? "Está activo para OPT-IA."
            : "Queda inactivo: revísalo y actívalo desde la lista para que OPT-IA lo use."}
        </p>
        <ExtractionNote extraction={job.extraction} />
      </div>
    );
  }

  if (job.phase === "stopped") {
    return (
      <p className="mt-3 rounded-xl border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-sm text-amber-200">
        «{job.title}»: {job.message}
      </p>
    );
  }

  return (
    <p className="mt-3 rounded-xl border border-rose-800/60 bg-rose-950/20 px-3 py-2 text-sm text-rose-200">
      {job.title ? `«${job.title}»: ` : ""}
      {job.message}
    </p>
  );
}

const ROW_ACTION =
  "rounded-md border border-slate-700 px-2 py-0.5 text-[11px] text-slate-200 hover:border-sky-500/50 hover:text-sky-200 disabled:opacity-50";

// onRun: continuar o reintentar (canProcess) o reindexar (canReindex); onToggle: activar
// (canActivate) o desactivar (activo). El panel decide qué llamar y el servidor, qué se permite.
function DocumentRow({
  doc,
  locked,
  toggling,
  onRun,
  onToggle,
}: {
  doc: LibraryDocument;
  locked: boolean;
  toggling: boolean;
  onRun: (doc: LibraryDocument) => void;
  onToggle: (doc: LibraryDocument, active: boolean) => void;
}) {
  const state = libraryDisplayState(doc);
  const hasActions = doc.canProcess || doc.canReindex || doc.canActivate || doc.isActive;
  return (
    <li className={`px-4 py-3 ${ROW_GRID}`}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-100" title={doc.title}>
            {doc.title}
          </span>
          {!doc.isActive && doc.status !== "ready" && (
            <span className="shrink-0 rounded-md border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
              Inactivo
            </span>
          )}
        </div>
        {doc.processingError && <p className="mt-1 line-clamp-2 text-xs text-rose-300">{doc.processingError}</p>}
        {hasActions && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {doc.canProcess && (
              <button type="button" onClick={() => onRun(doc)} disabled={locked} className={ROW_ACTION}>
                {doc.status === "failed" ? "Reintentar procesamiento" : "Continuar procesamiento"}
              </button>
            )}
            {doc.canReindex && (
              <button type="button" onClick={() => onRun(doc)} disabled={locked} className={ROW_ACTION}>
                {doc.chunks.total > 0 ? "Reindexar" : "Indexar"}
              </button>
            )}
            {doc.canActivate && (
              <button type="button" onClick={() => onToggle(doc, true)} disabled={locked} className={ROW_ACTION}>
                {toggling ? "Activando…" : "Activar para OPT-IA"}
              </button>
            )}
            {doc.isActive && (
              <button type="button" onClick={() => onToggle(doc, false)} disabled={locked} className={ROW_ACTION}>
                {toggling ? "Desactivando…" : "Desactivar"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* En móvil, una línea de datos; en la tabla, cada dato es una columna. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs md:contents">
        <div>
          <span className="rounded-md bg-slate-800/70 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-slate-300">
            {LIBRARY_FILE_TYPE_LABEL[doc.fileType]}
          </span>
        </div>

        <div className="flex items-center gap-2 text-slate-300">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[state]}`} aria-hidden="true" />
          <span>{LIBRARY_DISPLAY_LABEL[state]}</span>
          {doc.stalled && <span className="text-amber-300">· interrumpido</span>}
        </div>

        <div className="min-w-0">
          <span className="text-slate-200">
            {doc.chunks.total} {doc.chunks.total === 1 ? "fragmento" : "fragmentos"}
          </span>
          <span className="block text-[11px] text-slate-500">
            {doc.chunks.total > 0 ? describeChunks(doc) : "Sin indexar"}
            {needsReindex(doc) && doc.canReindex ? " · requiere reindexar" : ""}
          </span>
        </div>

        <div className="text-slate-400 md:text-right">{formatDate(doc.createdAt)}</div>
      </div>
    </li>
  );
}

export function AcademicLibraryPanel() {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_LIBRARY_FILTERS);
  const [job, setJob] = useState<Job>({ phase: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  // Documento que se está activando o desactivando.
  const [toggling, setToggling] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // silent: refresca la lista sin volver al estado de carga (después de subir o procesar).
  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!options.silent) setState({ status: "loading" });
    try {
      const res = await fetch("/api/teacher/library", { headers: await authHeaders() });
      const json: unknown = await res.json().catch(() => null);
      if (requestIdRef.current !== requestId) return;

      if (res.status === 401 || res.status === 403) {
        setState({ status: "denied" });
        return;
      }
      const data = res.ok ? readLibraryResponse(json) : null;
      if (!data) {
        setState({
          status: "error",
          message: readLibraryErrorMessage(json) ?? "No se pudo cargar la biblioteca. Intenta de nuevo.",
        });
        return;
      }
      setState({ status: "ready", documents: data.documents });
    } catch {
      if (requestIdRef.current === requestId) setState({ status: "error", message: "Error de red al cargar la biblioteca." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Encadena los pasos del servidor hasta que el documento queda listo o fallido. Si Gemini pide
  // esperar, espera y sigue; tras varias esperas, o sin conexión, lo deja para continuar después.
  // Muestra el progreso y devuelve cómo terminó (null si el panel se cerró): quien llama pinta el
  // final.
  const runProcessing = useCallback(
    async (
      documentId: string,
      docTitle: string,
      start: { total: number; extraction: LibraryExtractionReport | null; label: string | null }
    ): Promise<RunOutcome | null> => {
      const { label } = start;
      let extraction = start.extraction;
      setJob({ phase: "processing", title: docTitle, processed: 0, total: start.total, waiting: false, label, extraction });
      let waits = 0;

      for (let i = 0; i < MAX_STEPS; i++) {
        let res: Response;
        let json: unknown;
        try {
          res = await fetch(`/api/teacher/library/${encodeURIComponent(documentId)}/process`, {
            method: "POST",
            headers: await authHeaders(),
          });
          json = await res.json().catch(() => null);
        } catch {
          return mountedRef.current
            ? { kind: "stopped", message: "Se perdió la conexión. Continúa el procesamiento desde la lista." }
            : null;
        }
        if (!mountedRef.current) return null;

        const data = res.ok ? readProcessResponse(json) : null;
        if (!data) {
          const message = readLibraryErrorMessage(json) ?? "No se pudo procesar el documento.";
          return isSystemicFailure(res.status) ? { kind: "stopped", message } : { kind: "failed", message };
        }
        extraction = data.extraction ?? extraction;
        if (data.document.status === "failed") {
          return { kind: "failed", message: data.document.processingError ?? "El procesamiento falló." };
        }
        if (data.done) return { kind: "done", total: data.totalChunks, active: data.document.isActive, extraction };

        const total = data.totalChunks || start.total;
        if (data.retryAfterMs) {
          waits += 1;
          if (waits > MAX_RATE_LIMIT_WAITS) {
            return {
              kind: "stopped",
              message: "Gemini está limitando las solicitudes. Quedó a medio procesar: continúalo más tarde desde la lista.",
            };
          }
          setJob({ phase: "processing", title: docTitle, processed: data.processedChunks, total, waiting: true, label, extraction });
          await sleep(Math.min(data.retryAfterMs, MAX_WAIT_MS));
          if (!mountedRef.current) return null;
          continue;
        }
        waits = 0;
        setJob({ phase: "processing", title: docTitle, processed: data.processedChunks, total, waiting: false, label, extraction });
      }

      return { kind: "stopped", message: "El procesamiento no terminó. Continúalo desde la lista." };
    },
    []
  );

  // Un documento de la lista: si está pending, primero se reclama para reindexar; después, los pasos.
  const reindexOne = useCallback(
    async (doc: LibraryDocument, label: string | null): Promise<RunOutcome | null> => {
      setJob({ phase: "processing", title: doc.title, processed: 0, total: 0, waiting: false, label, extraction: null });
      if (!doc.canReindex) return runProcessing(doc.id, doc.title, { total: 0, extraction: null, label });

      const started = await requestReindex(doc.id);
      if (!mountedRef.current) return null;
      if (started.kind !== "started") return started;
      return runProcessing(doc.id, doc.title, { total: started.total, extraction: started.extraction, label });
    },
    [runProcessing]
  );

  const busy = job.phase === "uploading" || job.phase === "processing";
  // Las acciones de la lista esperan a que termine lo que está en curso, incluida una activación.
  const locked = busy || toggling !== null;

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    const problem = uploadCandidateProblem(file);
    if (problem) {
      setFileProblem(problem);
      return;
    }
    setFileProblem(null);
    setJob({ phase: "uploading", fileName: file.name });

    const form = new FormData();
    form.append("file", file);
    if (title.trim()) form.append("title", title.trim());

    try {
      const res = await fetch("/api/teacher/library", { method: "POST", headers: await authHeaders(), body: form });
      const json: unknown = await res.json().catch(() => null);
      if (!mountedRef.current) return;
      const data = res.ok ? readUploadResponse(json) : null;
      if (!data) {
        setJob({ phase: "error", title: file.name, message: readLibraryErrorMessage(json) ?? "No se pudo subir el archivo." });
        return;
      }

      setFile(null);
      setTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      void load({ silent: true });
      const outcome = await runProcessing(data.document.id, data.document.title, {
        total: data.totalChunks,
        extraction: null,
        label: null,
      });
      if (!outcome) return;
      setJob(finalJob(outcome, data.document.title));
      void load({ silent: true });
    } catch {
      if (mountedRef.current) setJob({ phase: "error", title: file.name, message: "Error de red al subir el archivo." });
    }
  }

  // Continuar o reintentar uno que quedó a medias, o reindexar una guía pendiente.
  async function runDocument(doc: LibraryDocument) {
    if (locked) return;
    const outcome = await reindexOne(doc, null);
    if (!outcome) return;
    setJob(finalJob(outcome, doc.title));
    void load({ silent: true });
  }

  // Reindexar pendientes: uno por uno, en el orden de la lista. Un documento que falla queda con su
  // motivo y se sigue con el siguiente; un corte (conexión, límite de Gemini, sesión o servidor)
  // detiene la fila, y volver a empezarla retoma desde ahí: lo listo ya no está en la cola.
  async function reindexPending(queue: readonly LibraryDocument[]) {
    if (locked || queue.length === 0) return;
    const summary: BatchSummary = { count: queue.length, ready: [], failed: [], stopped: null };
    for (const [index, doc] of queue.entries()) {
      const outcome = await reindexOne(doc, `Documento ${index + 1} de ${queue.length}`);
      if (!outcome) return;
      if (outcome.kind === "done") {
        summary.ready.push({ title: doc.title, total: outcome.total, warnings: outcome.extraction?.warnings ?? [] });
      } else if (outcome.kind === "failed") {
        summary.failed.push({ title: doc.title, message: outcome.message });
      } else {
        summary.stopped = { title: doc.title, message: outcome.message };
        break;
      }
      void load({ silent: true });
    }
    setJob({ phase: "batch", summary });
    void load({ silent: true });
  }

  // Activar o desactivar para OPT-IA. Activar pide confirmación: desde ese momento el asistente lo
  // usa como apoyo. El servidor decide si se puede (listo y con los fragmentos del modelo actual).
  async function toggleActive(doc: LibraryDocument, active: boolean) {
    if (locked) return;
    if (
      active &&
      !window.confirm(
        `¿Activar «${doc.title}» para OPT-IA?\n\nEl asistente lo usará como apoyo en sus respuestas. Solo usa el texto digital que se extrajo: las imágenes, los diagramas y las páginas escaneadas no.`
      )
    ) {
      return;
    }
    setToggling(doc.id);
    try {
      const res = await fetch("/api/teacher/library", {
        method: "PATCH",
        headers: { ...(await authHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({ id: doc.id, active }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!mountedRef.current) return;
      const data = res.ok ? readActivationResponse(json) : null;
      if (!data) {
        const message = readLibraryErrorMessage(json) ?? "No se pudo cambiar la activación.";
        setJob({ phase: "notice", tone: "error", message: `«${doc.title}»: ${message}` });
        return;
      }
      setJob({
        phase: "notice",
        tone: "success",
        message: data.document.isActive
          ? `«${doc.title}» está activo para OPT-IA.`
          : `«${doc.title}» quedó inactivo: OPT-IA ya no lo usa.`,
      });
      void load({ silent: true });
    } catch {
      if (mountedRef.current) setJob({ phase: "notice", tone: "error", message: "Error de red al cambiar la activación." });
    } finally {
      if (mountedRef.current) setToggling(null);
    }
  }

  const documents = useMemo(() => (state.status === "ready" ? state.documents : []), [state]);
  const reindexQueue = useMemo(() => pendingReindexQueue(documents), [documents]);
  const visible = useMemo(() => filterLibraryDocuments(documents, filters), [documents, filters]);
  const counts = useMemo(() => countByStatus(documents), [documents]);
  const stats = useMemo(() => {
    const states = documents.map(libraryDisplayState);
    return {
      active: states.filter((s) => s === "active").length,
      readyInactive: states.filter((s) => s === "ready_inactive").length,
      pending: states.filter((s) => s === "pending").length,
    };
  }, [documents]);
  const filtered = !isDefaultLibraryFilters(filters);

  return (
    <section className="space-y-4" aria-labelledby="library-intro">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
        <p id="library-intro" className="text-sm text-slate-300">
          Guías y documentos que el asistente puede usar como apoyo académico. Los estudiantes no ven esta lista ni las
          fuentes de las respuestas.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Un documento procesado queda listo e inactivo: OPT-IA solo usa los que actives después de revisarlos.
        </p>

        {state.status === "ready" && documents.length > 0 && (
          <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Documentos" value={documents.length} />
            <Stat label="Activos para OPT-IA" value={stats.active} />
            <Stat label="Listos, inactivos" value={stats.readyInactive} />
            <Stat label="Pendientes de indexar" value={stats.pending} />
          </dl>
        )}

        {state.status === "ready" && reindexQueue.length > 0 && (
          <div className="mt-3 flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-slate-400">
              {reindexQueue.length === 1
                ? "1 documento sin indexar con el modelo actual o a medio procesar."
                : `${reindexQueue.length} documentos sin indexar con el modelo actual o a medio procesar.`}{" "}
              Se procesan uno por uno desde su archivo en Storage; los fragmentos anteriores se conservan.
            </p>
            <button
              type="button"
              onClick={() => void reindexPending(reindexQueue)}
              disabled={locked}
              className="shrink-0 rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-600 disabled:opacity-60"
            >
              Reindexar pendientes ({reindexQueue.length})
            </button>
          </div>
        )}

        <div aria-live="polite">
          <JobStatus job={job} />
        </div>
      </div>

      {state.status !== "denied" && (
        <form onSubmit={handleUpload} className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4" aria-labelledby="library-upload-title">
          <h2 id="library-upload-title" className="text-sm font-semibold text-slate-100">
            Subir documento
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            PDF digital o DOCX, hasta 4 MB. Un PDF escaneado no sirve: la Biblioteca no tiene OCR.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
            <label className="block">
              <span className="text-xs text-slate-400">Archivo</span>
              <input
                ref={fileInputRef}
                type="file"
                accept={LIBRARY_UPLOAD_ACCEPT}
                disabled={busy}
                onChange={(e) => {
                  const picked = e.target.files?.[0] ?? null;
                  setFile(picked);
                  setFileProblem(picked ? uploadCandidateProblem(picked) : null);
                }}
                className="mt-1 block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-sm file:text-slate-100 hover:file:bg-slate-700 disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400">Título (opcional)</span>
              <input
                type="text"
                value={title}
                maxLength={200}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Por defecto, el nombre del archivo"
                className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !file || fileProblem !== null}
              className="rounded-lg bg-sky-700 px-5 py-2 text-sm font-semibold text-white hover:bg-sky-600 disabled:opacity-60 sm:col-span-2 lg:col-span-1"
            >
              Subir y procesar
            </button>
          </div>
          <div aria-live="polite">{fileProblem && <p className="mt-2 text-xs text-rose-300">{fileProblem}</p>}</div>
        </form>
      )}

      <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_13rem_11rem_auto] lg:items-end">
          <label className="block sm:col-span-2 lg:col-span-1">
            <span className="text-xs text-slate-400">Buscar</span>
            <input
              type="search"
              value={filters.query}
              onChange={(e) => setFilters((prev) => ({ ...prev, query: e.target.value }))}
              placeholder="Ej: balanceo de línea"
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
            />
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Estado</span>
            <select
              value={filters.status}
              onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value as LibraryStatusFilter }))}
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm"
            >
              <option value="all">Todos ({documents.length})</option>
              {LIBRARY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {LIBRARY_STATUS_LABEL[status]} ({counts[status]})
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-slate-400">Participación</span>
            <select
              value={filters.availability}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, availability: e.target.value as LibraryAvailabilityFilter }))
              }
              className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm"
            >
              <option value="all">Todos</option>
              <option value="active">Activos</option>
              <option value="inactive">Inactivos</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => void load()}
            disabled={state.status === "loading"}
            className="rounded-lg bg-slate-800 px-5 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-60"
          >
            Actualizar
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/20">
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3" aria-live="polite">
          <p className="text-sm text-slate-300">
            {state.status === "loading"
              ? "Cargando…"
              : state.status === "ready"
                ? filtered
                  ? `${visible.length} de ${documents.length} documentos`
                  : `${documents.length} ${documents.length === 1 ? "documento" : "documentos"}`
                : "Biblioteca"}
          </p>
          {state.status === "ready" && filtered && (
            <button
              type="button"
              onClick={() => setFilters(DEFAULT_LIBRARY_FILTERS)}
              className="text-xs text-sky-300 hover:text-sky-200"
            >
              Limpiar filtros
            </button>
          )}
        </div>

        {state.status === "loading" && (
          <ul className="divide-y divide-slate-800" aria-hidden="true">
            {[0, 1, 2].map((key) => (
              <li key={key} className="px-4 py-4">
                <div className="h-3.5 w-2/3 animate-pulse rounded bg-slate-800/80 md:w-1/3" />
                <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-slate-800/50 md:w-1/4" />
              </li>
            ))}
          </ul>
        )}

        {state.status === "denied" && (
          <div className="px-4 py-10 text-center text-sm text-slate-400">Solo docentes pueden ver la Biblioteca Académica.</div>
        )}

        {state.status === "error" && (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-rose-300">{state.message}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 rounded-lg border border-slate-700 px-4 py-1.5 text-xs text-slate-200 hover:border-slate-500"
            >
              Reintentar
            </button>
          </div>
        )}

        {state.status === "ready" && documents.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-slate-400">Todavía no hay documentos en la biblioteca.</div>
        )}

        {state.status === "ready" && documents.length > 0 && visible.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            Ningún documento coincide con la búsqueda o los filtros.
          </div>
        )}

        {state.status === "ready" && visible.length > 0 && (
          <>
            <div
              className={`hidden border-b border-slate-800 px-4 py-2 text-[11px] uppercase tracking-wide text-slate-500 ${ROW_GRID}`}
              aria-hidden="true"
            >
              <span>Documento</span>
              <span>Formato</span>
              <span>Estado</span>
              <span>Fragmentos</span>
              <span className="text-right">Fecha</span>
            </div>
            <ul className="divide-y divide-slate-800">
              {visible.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  locked={locked}
                  toggling={toggling === doc.id}
                  onRun={(target) => void runDocument(target)}
                  onToggle={(target, active) => void toggleActive(target, active)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
