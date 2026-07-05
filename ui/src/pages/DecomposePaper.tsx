import { useCallback, useEffect, useRef, useState } from "react";
import { decomposeApi, type DecomposeEvent, type DecomposeRunSummary } from "../api/decompose";

// status -> [symbol, color] — mirrors the terminal engine's rendering.
const STYLE: Record<string, [string, string]> = {
  start: ["▶", "#0ea5e9"],
  progress: ["·", "#64748b"],
  ok: ["✓", "#16a34a"],
  warn: ["⚠", "#ca8a04"],
  blocked: ["✋", "#c026d3"],
  error: ["✗", "#dc2626"],
  done: ["■", "#16a34a"],
  info: ["i", "#2563eb"],
};
const LABELS: Record<string, string> = {
  ingest: "Read paper",
  precedent: "Check prior / failed papers",
  decompose: "Decompose claim",
  deps: "Check dependencies",
  feasibility: "Check test requirements",
  data: "Data acquisition",
  spec: "Author backtest spec",
  backtest: "Run backtest",
  judge: "Judge results",
  shadow: "Shadow register",
  report: "Summarize report",
};

type Mode = "file" | "text" | "url";

function EventLine({ ev }: { ev: DecomposeEvent }) {
  const [sym, color] = STYLE[ev.status] ?? ["·", "#64748b"];
  const isStage = ev.step.startsWith("stage:");
  const label = isStage ? `↳ ${ev.step.split(":")[1]}` : (LABELS[ev.step] ?? ev.step);
  return (
    <div className="whitespace-pre-wrap break-words" style={{ paddingLeft: isStage ? 26 : 0 }}>
      <span className="text-muted-foreground/60 mr-2">[{ev.ts.slice(11, 19)}]</span>
      <span style={{ color, width: "1.3em", display: "inline-block" }}>{sym}</span>
      <span style={{ color, fontWeight: 600 }}>{label}</span>
      {ev.msg ? <span className="text-muted-foreground"> — {ev.msg}</span> : null}
    </div>
  );
}

export function DecomposePaper() {
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<DecomposeEvent[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [history, setHistory] = useState<DecomposeRunSummary[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [error, setError] = useState("");

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeq = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  const loadHistory = useCallback(async () => {
    try { setHistory((await decomposeApi.runs()).runs); } catch { /* ignore */ }
  }, []);

  const finish = useCallback(async (id: string) => {
    setStatus("done");
    try {
      const res = await fetch(decomposeApi.reportUrl(id), { credentials: "include" });
      if (res.ok) setReport(await res.text());
    } catch { /* ignore */ }
    void loadHistory();
  }, [loadHistory]);

  const poll = useCallback((id: string) => {
    const tick = async () => {
      let done = false;
      let running = true;
      try {
        const r = await decomposeApi.events(id, lastSeq.current);
        if (r.events.length) {
          setEvents((prev) => [...prev, ...r.events]);
          lastSeq.current = r.events[r.events.length - 1].seq;
        }
        done = r.done;
        running = r.running;
      } catch { /* transient */ }
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      if (done || (!running && lastSeq.current > 0)) { void finish(id); return; }
      timer.current = setTimeout(tick, 800);
    };
    void tick();
  }, [finish]);

  const openRun = useCallback((id: string) => {
    if (timer.current) clearTimeout(timer.current);
    lastSeq.current = 0;
    setEvents([]); setReport(null); setRunId(id); setStatus("running"); setError("");
    poll(id);
  }, [poll]);

  const submit = useCallback(async () => {
    setError("");
    const form = new FormData();
    if (mode === "file") {
      if (!file) { setError("Choose a file first."); return; }
      form.append("file", file);
    } else if (mode === "text") {
      if (!text.trim()) { setError("Paste some text first."); return; }
      form.append("text", text.trim());
    } else {
      if (!url.trim()) { setError("Enter a URL first."); return; }
      form.append("url", url.trim());
    }
    try {
      const { runId: id } = await decomposeApi.start(form);
      openRun(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    }
  }, [mode, file, text, url, openRun]);

  useEffect(() => {
    void loadHistory();
    const h = setInterval(() => void loadHistory(), 8000);
    return () => { clearInterval(h); if (timer.current) clearTimeout(timer.current); };
  }, [loadHistory]);

  const tabBtn = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={`rounded-md border px-3 py-1.5 text-sm ${mode === m ? "border-primary bg-accent text-foreground" : "border-border bg-muted/40 text-muted-foreground"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto flex max-w-6xl gap-6 p-6">
      <aside className="hidden w-64 shrink-0 md:block">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Runs</h2>
        <div className="flex flex-col gap-2">
          {history.length === 0 && <div className="text-sm text-muted-foreground">No runs yet</div>}
          {history.map((r) => (
            <button
              key={r.runId}
              type="button"
              onClick={() => openRun(r.runId)}
              className="rounded-lg border border-border bg-card p-2 text-left hover:border-primary"
            >
              <div className="truncate text-sm">{(r.title || r.runId).slice(0, 60)}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">{r.runId}</div>
              {r.running ? (
                <span className="mt-1 inline-block rounded-full border border-border bg-muted px-2 py-0.5 text-[10px]">running</span>
              ) : r.verdict ? (
                <span className="mt-1 inline-block rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{r.verdict}</span>
              ) : null}
            </button>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <header className="mb-5">
          <h1 className="text-xl font-semibold">Research Decomposer</h1>
          <p className="text-sm text-muted-foreground">
            Upload a paper (PDF / text / arXiv URL) — watch every processing step stream live, then read the report.
          </p>
        </header>

        <section className="mb-5 rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex gap-2">
            {tabBtn("file", "Upload file")}
            {tabBtn("text", "Paste text")}
            {tabBtn("url", "URL / arXiv")}
          </div>
          {mode === "file" && (
            <label className="flex cursor-pointer flex-col items-center rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              <input
                type="file"
                accept=".pdf,.txt,.md"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? <span className="text-foreground">selected: {file.name}</span> : "Choose a PDF / .txt / .md"}
            </label>
          )}
          {mode === "text" && (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the paper text or a one-paragraph claim, e.g. '$CL crude oil: go long from 10 ET to 14 ET intraday, exit at open.'"
              className="min-h-24 w-full rounded-lg border border-border bg-background p-3 font-mono text-sm"
            />
          )}
          {mode === "url" && (
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://arxiv.org/abs/XXXX.XXXXX  or a direct .pdf/.txt URL"
              className="w-full rounded-lg border border-border bg-background p-2.5 text-sm"
            />
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={status === "running"}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {status === "running" ? "Running…" : "Decompose"}
            </button>
            {error && <span className="text-sm text-destructive">{error}</span>}
          </div>
        </section>

        <section className="mb-5 rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <strong className="text-sm">Processing log</strong>
            {runId && <span className="font-mono text-xs text-muted-foreground">{runId}</span>}
          </div>
          <div
            ref={logRef}
            className="max-h-[52vh] min-h-28 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[13px] leading-7"
          >
            {events.length === 0 ? (
              <div className="py-6 text-center text-muted-foreground">the live step-by-step log will stream here</div>
            ) : (
              events.map((ev) => <EventLine key={`${ev.seq}-${ev.step}`} ev={ev} />)
            )}
          </div>
        </section>

        {report && (
          <section className="rounded-xl border border-border bg-card p-4">
            <strong className="text-sm">Report</strong>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 font-mono text-xs">{report}</pre>
          </section>
        )}
      </main>
    </div>
  );
}
