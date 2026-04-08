import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Check, Download, Loader2, RefreshCw, Zap, AlertCircle, X, XCircle } from "lucide-react";
import { cn } from "../../lib/utils";
import { DEFAULT_OLLAMA_BASE_URL } from "@paperclipai/adapter-ollama-local";

// ---------------------------------------------------------------------------
// Module-level persistent download state — survives component unmount/remount
// so navigating away and back keeps progress intact.
// ---------------------------------------------------------------------------
type DownloadStatus = "idle" | "pulling" | "done" | "error";

interface DownloadState {
  status: DownloadStatus;
  /** Human-readable status, e.g. "Downloading…", "Installed!" */
  statusText: string;
  /** 0–100 */
  percent: number;
  error?: string;
}

const _globalDownloads = new Map<string, DownloadState>();
const _globalAborts = new Map<string, AbortController>();
/** Listeners so components can re-render when module-level state changes */
const _listeners = new Set<() => void>();

/** Composite key to avoid collisions when the same model name is used on different servers. */
function downloadKey(modelId: string, baseUrl?: string): string {
  return baseUrl ? `${baseUrl}::${modelId}` : modelId;
}

function notifyListeners() {
  _listeners.forEach((fn) => fn());
}

function setDownloadState(key: string, state: DownloadState) {
  _globalDownloads.set(key, state);
  notifyListeners();
}

function deleteDownloadState(key: string) {
  _globalDownloads.delete(key);
  notifyListeners();
}

/** Returns a snapshot of the global downloads map for rendering */
function useGlobalDownloads(): Record<string, DownloadState> {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, []);
  return Object.fromEntries(_globalDownloads.entries());
}

interface ModelEntry {
  id: string;
  label: string;
  desc: string;
  size: string;
  /** Tags: "tool-use" = supports function/tool calling; "code" = code-specialized; "reasoning" = reasoning-optimized */
  tags: string[];
}

/** Curated list of free Ollama models known to support agentic tasks (tool calling, instruction following, code). */
const AGENTIC_MODELS: ModelEntry[] = [
  // --- Fast & small — good for local machines ---
  {
    id: "llama3.2:3b",
    label: "Llama 3.2 3B",
    desc: "Meta · fast, tool calling",
    size: "2 GB",
    tags: ["tool-use", "fast"],
  },
  {
    id: "phi4-mini",
    label: "Phi 4 Mini 3.8B",
    desc: "Microsoft · smart small model, tool calling",
    size: "2.5 GB",
    tags: ["tool-use", "fast"],
  },
  {
    id: "gemma3:4b",
    label: "Gemma 3 4B",
    desc: "Google · efficient, follows instructions well",
    size: "3.3 GB",
    tags: ["tool-use", "fast"],
  },
  // --- Balanced — great everyday agents ---
  {
    id: "llama3.1:8b",
    label: "Llama 3.1 8B",
    desc: "Meta · strong tool calling, great for agents",
    size: "4.7 GB",
    tags: ["tool-use"],
  },
  {
    id: "qwen2.5:7b",
    label: "Qwen 2.5 7B",
    desc: "Alibaba · excellent tool calling",
    size: "4.4 GB",
    tags: ["tool-use"],
  },
  {
    id: "mistral-nemo",
    label: "Mistral NeMo 12B",
    desc: "Mistral · efficient, tool calling support",
    size: "7.1 GB",
    tags: ["tool-use"],
  },
  {
    id: "deepseek-r1:8b",
    label: "DeepSeek R1 8B",
    desc: "DeepSeek · reasoning + agentic tasks",
    size: "4.9 GB",
    tags: ["reasoning", "tool-use"],
  },
  // --- Code agents ---
  {
    id: "qwen2.5-coder:7b",
    label: "Qwen 2.5 Coder 7B",
    desc: "Alibaba · code-specialized agent, tool calling",
    size: "4.7 GB",
    tags: ["code", "tool-use"],
  },
  {
    id: "deepseek-coder-v2",
    label: "DeepSeek Coder V2",
    desc: "DeepSeek · excellent code generation",
    size: "8.9 GB",
    tags: ["code", "tool-use"],
  },
  {
    id: "qwen2.5-coder:32b",
    label: "Qwen 2.5 Coder 32B",
    desc: "Alibaba · best local code agent, tool calling",
    size: "20 GB",
    tags: ["code", "tool-use"],
  },
  // --- High quality ---
  {
    id: "phi4",
    label: "Phi 4 14B",
    desc: "Microsoft · excellent reasoning & tool calling",
    size: "9.1 GB",
    tags: ["tool-use", "reasoning"],
  },
  {
    id: "qwen2.5:14b",
    label: "Qwen 2.5 14B",
    desc: "Alibaba · powerful, reliable tool calling",
    size: "9 GB",
    tags: ["tool-use"],
  },
  {
    id: "deepseek-r1:14b",
    label: "DeepSeek R1 14B",
    desc: "DeepSeek · strong reasoning model",
    size: "9 GB",
    tags: ["reasoning", "tool-use"],
  },
  // --- Large & powerful ---
  {
    id: "llama3.3:70b",
    label: "Llama 3.3 70B",
    desc: "Meta · best open-source agentic model",
    size: "43 GB",
    tags: ["tool-use"],
  },
  {
    id: "llama3.1:70b",
    label: "Llama 3.1 70B",
    desc: "Meta · powerful, excellent tool calling",
    size: "40 GB",
    tags: ["tool-use"],
  },
];

interface OllamaModelPickerProps {
  /** Currently installed models from the adapter models API */
  installedModels: { id: string; label: string }[];
  /** Currently selected model id/name */
  value: string;
  onChange: (model: string) => void;
  /** Whether to show a loading state for the installed models list */
  loading?: boolean;
  /** Allow manual refresh of the installed models list */
  onRefresh?: () => void;
  /** Ollama base URL — defaults to http://localhost:11434 */
  baseUrl?: string;
}

const TAG_LABELS: Record<string, string> = {
  "tool-use": "Tool Calling",
  code: "Code Agent",
  reasoning: "Reasoning",
  fast: "Fast",
};

function isModelInstalled(
  modelId: string,
  installedModels: { id: string; label: string }[],
): boolean {
  const lower = modelId.toLowerCase();
  const isTagged = modelId.includes(":");
  return installedModels.some((m) => {
    const mLower = m.id.toLowerCase();
    // Exact match always works
    if (mLower === lower) return true;
    // Base-name fallback only for untagged requests
    if (!isTagged) {
      return mLower.split(":")[0] === lower || mLower === lower + ":latest";
    }
    return false;
  });
}

function getInstalledId(
  modelId: string,
  installedModels: { id: string; label: string }[],
): string {
  const lower = modelId.toLowerCase();
  const isTagged = modelId.includes(":");
  const match = installedModels.find((m) => {
    const mLower = m.id.toLowerCase();
    if (mLower === lower) return true;
    if (!isTagged) {
      return mLower.split(":")[0] === lower || mLower === lower + ":latest";
    }
    return false;
  });
  return match?.id ?? modelId;
}

export function OllamaModelPicker({
  installedModels,
  value,
  onChange,
  loading,
  onRefresh,
  baseUrl,
}: OllamaModelPickerProps) {
  const downloads = useGlobalDownloads();
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const effectiveBaseUrl = (baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
  const effectiveBaseUrlRef = useRef(effectiveBaseUrl);
  effectiveBaseUrlRef.current = effectiveBaseUrl;

  // Fetch installed models directly from the configured Ollama host so the
  // picker always reflects the right server, even when the server-side
  // listOllamaModels() defaults to localhost.
  const [clientModels, setClientModels] = useState<{ id: string; label: string }[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshModels = useCallback(() => {
    setRefreshTick((n) => n + 1);
    onRefreshRef.current?.();
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${effectiveBaseUrl}/api/tags`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as Record<string, unknown>;
        if (cancelled || !Array.isArray(body.models)) return;
        const models = (body.models as Record<string, unknown>[])
          .filter((m) => typeof m.name === "string")
          .map((m) => {
            const name = m.name as string;
            const base = name.split(":")[0];
            const tag = name.includes(":") ? name.split(":")[1] : null;
            return { id: name, label: tag && tag !== "latest" ? `${base} (${tag})` : base };
          });
        setClientModels(models);
      } catch {
        // ignore — fall back to server-provided models
      }
    })();
    return () => { cancelled = true; };
  }, [effectiveBaseUrl, refreshTick]);

  // Merge server-provided and client-fetched models, deduplicating by id
  const mergedInstalled = useMemo(() => {
    const seen = new Set<string>();
    const result: { id: string; label: string }[] = [];
    for (const m of [...clientModels, ...installedModels]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        result.push(m);
      }
    }
    return result;
  }, [installedModels, clientModels]);

  // Extra installed models not already covered by the agentic catalog
  const extraInstalled = mergedInstalled.filter(
    (m) => !AGENTIC_MODELS.some((p) => isModelInstalled(p.id, [m])),
  );

  const startDownload = useCallback(async (modelId: string) => {
    const key = downloadKey(modelId, effectiveBaseUrlRef.current);
    // Cancel any existing download for this model
    _globalAborts.get(key)?.abort();

    const controller = new AbortController();
    _globalAborts.set(key, controller);

    setDownloadState(key, { status: "pulling", statusText: "Starting…", percent: 0 });

    try {
      const res = await fetch(`${effectiveBaseUrlRef.current}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, stream: true }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Ollama responded with ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj: { status?: string; total?: number; completed?: number; error?: string };
          try {
            obj = JSON.parse(trimmed) as typeof obj;
          } catch {
            // non-fatal JSON parse errors — skip malformed lines
            continue;
          }

          if (obj.error) throw new Error(obj.error);

          let percent = _globalDownloads.get(key)?.percent ?? 0;
          if (obj.total && obj.completed) {
            percent = Math.round((obj.completed / obj.total) * 100);
          }

          if (obj.status === "success") {
            setDownloadState(key, { status: "done", statusText: "Installed!", percent: 100 });
            _globalAborts.delete(key);
            setRefreshTick((n) => n + 1);
            onRefreshRef.current?.();
            return;
          }

          // Filter out raw hash lines like "pulling 60e05f2100…"
          const rawStatus = obj.status ?? "Downloading…";
          const isHashLine = /^pulling\s+[0-9a-f]{8,}/i.test(rawStatus);
          const statusText = isHashLine
            ? (_globalDownloads.get(key)?.statusText ?? "Downloading…")
            : rawStatus;

          setDownloadState(key, { status: "pulling", statusText, percent });
        }
      }

      // Parse any trailing data left in buffer after stream EOF
      if (buffer.trim()) {
        try {
          const obj = JSON.parse(buffer.trim()) as { status?: string; error?: string };
          if (obj.error) throw new Error(obj.error);
          if (obj.status === "success") {
            setDownloadState(key, { status: "done", statusText: "Installed!", percent: 100 });
            _globalAborts.delete(key);
            setRefreshTick((n) => n + 1);
            onRefreshRef.current?.();
            return;
          }
        } catch (e) {
          // Re-throw Ollama errors; swallow JSON parse errors
          if (e instanceof SyntaxError) {
            // malformed trailing data — fall through
          } else {
            throw e;
          }
        }
      }

      // Stream ended without explicit "success" status — treat as incomplete
      setDownloadState(key, {
        status: "error",
        statusText: "Download ended without confirmation. Try again.",
        percent: _globalDownloads.get(key)?.percent ?? 0,
      });
      _globalAborts.delete(key);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Cancelled by user — clean up state
        deleteDownloadState(key);
        _globalAborts.delete(key);
        return;
      }
      setDownloadState(key, {
        status: "error",
        statusText: "Failed",
        percent: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      _globalAborts.delete(key);
    }
  }, []);

  function cancelDownload(modelId: string) {
    const key = downloadKey(modelId, effectiveBaseUrlRef.current);
    _globalAborts.get(key)?.abort();
  }

  function dismissError(modelId: string) {
    const key = downloadKey(modelId, effectiveBaseUrlRef.current);
    deleteDownloadState(key);
  }

  function selectModel(installedId: string) {
    onChange(installedId === value ? "" : installedId);
  }

  const installedCount =
    AGENTIC_MODELS.filter((m) => isModelInstalled(m.id, mergedInstalled)).length +
    extraInstalled.length;

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-yellow-500" />
          <span className="text-xs font-medium">Agentic models</span>
          {installedCount > 0 && (
            <span className="text-[10px] text-green-600 dark:text-green-400">
              ({installedCount} installed)
            </span>
          )}
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh installed models"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            Refresh
          </button>
        )}
      </div>

      {/* Loading state */}
      {loading && mergedInstalled.length === 0 && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking Ollama for installed models…
        </div>
      )}

      {/* Agentic models list */}
      <div className="grid grid-cols-1 gap-1.5">
        {AGENTIC_MODELS.map((m) => {
          const installed = isModelInstalled(m.id, mergedInstalled);
          const dl = downloads[downloadKey(m.id, effectiveBaseUrl)];
          const installedId = installed
            ? getInstalledId(m.id, mergedInstalled)
            : m.id;
          const selected =
            value === installedId ||
            value === m.id ||
            // Only do base-name matching when the current value is untagged
            (installed &&
              !value.includes(":") &&
              value.toLowerCase() === m.id.split(":")[0].toLowerCase());

          return (
            <div
              key={m.id}
              className={cn(
                "flex items-start gap-3 rounded-md border px-3 py-2 text-xs transition-colors",
                installed
                  ? selected
                    ? "border-green-500/60 bg-green-500/10 cursor-pointer"
                    : "border-border hover:border-green-500/40 hover:bg-green-500/5 cursor-pointer"
                  : "border-border/40",
              )}
              onClick={() => installed && selectModel(installedId)}
            >
              {/* Status indicator */}
              <div className="shrink-0 mt-0.5">
                {installed ? (
                  <div
                    className={cn(
                      "h-4 w-4 rounded-full flex items-center justify-center",
                      selected
                        ? "bg-green-500 text-white"
                        : "bg-green-500/20 text-green-600",
                    )}
                  >
                    <Check className="h-2.5 w-2.5" />
                  </div>
                ) : (
                  <div className="h-4 w-4 rounded-full bg-muted/60 flex items-center justify-center">
                    <Download className="h-2.5 w-2.5 text-muted-foreground/60" />
                  </div>
                )}
              </div>

              {/* Model info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className={cn(
                      "font-medium",
                      selected && "text-green-700 dark:text-green-400",
                      !installed && "text-muted-foreground",
                    )}
                  >
                    {m.label}
                  </span>
                  <span className="text-[10px] text-muted-foreground/50 shrink-0">
                    {m.size}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                  {m.desc}
                </div>
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  {m.tags.map((tag) => (
                    <span
                      key={tag}
                      className={cn(
                        "inline-block px-1 py-0 rounded text-[9px] font-medium leading-4",
                        tag === "tool-use"
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : tag === "code"
                            ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                            : tag === "reasoning"
                              ? "bg-orange-500/10 text-orange-600 dark:text-orange-400"
                              : "bg-muted text-muted-foreground",
                      )}
                    >
                      {TAG_LABELS[tag] ?? tag}
                    </span>
                  ))}
                </div>
              </div>

              {/* Action */}
              <div className="shrink-0 mt-0.5 min-w-[80px] flex justify-end">
                {installed ? (
                  <span
                    className={cn(
                      "text-[10px] font-medium",
                      selected
                        ? "text-green-600 dark:text-green-400"
                        : "text-muted-foreground",
                    )}
                  >
                    {selected ? "Selected" : "Use"}
                  </span>
                ) : dl?.status === "done" ? (
                  <span className="text-[10px] font-medium text-green-600 dark:text-green-400 flex items-center gap-1">
                    <Check className="h-2.5 w-2.5" />
                    Installed!
                  </span>
                ) : dl?.status === "pulling" ? (
                  <div className="flex flex-col items-end gap-0.5 w-full">
                    <div className="flex items-center justify-between w-full">
                      <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        {dl.percent > 0 ? `${dl.percent}%` : "…"}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); cancelDownload(m.id); }}
                        className="text-[9px] text-muted-foreground hover:text-destructive flex items-center gap-0.5 transition-colors"
                        title="Cancel download"
                      >
                        <XCircle className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="w-full bg-muted rounded-full h-1 overflow-hidden">
                      <div
                        className="bg-blue-500 h-1 rounded-full transition-all duration-300"
                        style={{ width: `${dl.percent}%` }}
                      />
                    </div>
                  </div>
                ) : dl?.status === "error" ? (
                  <div className="flex flex-col items-end gap-0.5">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); dismissError(m.id); }}
                      className="text-[9px] text-destructive flex items-center gap-0.5 hover:underline"
                      title={dl.error}
                    >
                      <AlertCircle className="h-2.5 w-2.5" />
                      Failed
                      <X className="h-2 w-2" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void startDownload(m.id); }}
                      className="text-[9px] text-muted-foreground hover:text-foreground underline"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void startDownload(m.id);
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors border border-blue-500/20"
                    title={`Download ${m.label} (${m.size})`}
                  >
                    <Download className="h-2.5 w-2.5" />
                    Download
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Extra installed models not in the agentic catalog */}
        {extraInstalled.map((m) => {
          const selected = value === m.id;
          return (
            <div
              key={m.id}
              className={cn(
                "flex items-center gap-3 rounded-md border px-3 py-2 text-xs transition-colors cursor-pointer",
                selected
                  ? "border-green-500/60 bg-green-500/10"
                  : "border-border hover:border-green-500/40 hover:bg-green-500/5",
              )}
              onClick={() => selectModel(m.id)}
            >
              <div className="shrink-0">
                <div
                  className={cn(
                    "h-4 w-4 rounded-full flex items-center justify-center",
                    selected
                      ? "bg-green-500 text-white"
                      : "bg-green-500/20 text-green-600",
                  )}
                >
                  <Check className="h-2.5 w-2.5" />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className={cn(
                    "font-medium",
                    selected && "text-green-700 dark:text-green-400",
                  )}
                >
                  {m.label}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Installed locally
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 text-[10px] font-medium",
                  selected
                    ? "text-green-600 dark:text-green-400"
                    : "text-muted-foreground",
                )}
              >
                {selected ? "Selected" : "Use"}
              </span>
            </div>
          );
        })}
      </div>

      {/* No Ollama hint */}
      {!loading && mergedInstalled.length === 0 && Object.keys(downloads).length === 0 && (
        <p className="text-[11px] text-muted-foreground bg-muted/50 rounded px-2.5 py-2">
          Ollama not detected or no models installed. Click{" "}
          <strong className="font-medium text-foreground">Download</strong>{" "}
          next to any model to install it from Ollama.
        </p>
      )}

      {/* Manual override input */}
      <div className="pt-1">
        <label className="text-[10px] text-muted-foreground mb-1 block">
          Or enter a model name manually
        </label>
        <input
          type="text"
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40"
          placeholder="e.g. llama3.1:8b or qwen2.5-coder:7b"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
