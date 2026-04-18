import { useState } from "react";
import { Cpu, Download, Trash2, Play, HardDrive, Zap, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tauriInvoke } from "@/api/tauri-client";
import { queryKeys } from "@/lib/queryKeys";

interface LocalModel {
  id: string;
  name: string;
  family: string;
  size: string;
  quantization: string;
  context_length: number;
  status: "ready" | "downloading";
  tokens_per_sec: number | null;
}

const AVAILABLE_MODELS = [
  { name: "Gemma 2 2B", family: "gemma", size: "1.5 GB" },
  { name: "Qwen 2.5 7B", family: "qwen", size: "4.7 GB" },
  { name: "DeepSeek Coder 6.7B", family: "deepseek", size: "3.8 GB" },
];

export function LocalAI() {
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const queryClient = useQueryClient();

  const { data: models = [], isLoading } = useQuery({
    queryKey: queryKeys.localModels.all,
    queryFn: () => tauriInvoke<LocalModel[]>("list_local_models"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tauriInvoke("delete_model", { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.localModels.all }),
  });

  // Auto-select first model if none selected
  const activeModel = selectedModel || models[0]?.id || "";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin" style={{ color: "var(--fg-muted)" }} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Local AI</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--fg-muted)" }}>Run models locally for privacy and offline use</p>
      </div>

      {/* System info */}
      <div className="mb-6 grid grid-cols-3 gap-4">
        <InfoTile icon={Cpu} label="Platform" value="macOS ARM64" />
        <InfoTile icon={Zap} label="Acceleration" value="Metal GPU" />
        <InfoTile icon={HardDrive} label="Models" value={`${models.length} installed`} />
      </div>

      {/* Installed models */}
      <div className="mb-8">
        <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--fg-muted)" }}>Installed Models</h3>
        {models.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border py-10" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
            <Cpu size={24} className="mb-2 opacity-30" style={{ color: "var(--fg-muted)" }} />
            <p className="text-[12px]" style={{ color: "var(--fg-muted)" }}>No local models installed</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {models.map((model) => (
              <div key={model.id} className="flex items-center gap-4 rounded-lg border px-5 py-3" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--accent-subtle)" }}>
                  <Cpu size={16} style={{ color: "var(--accent)" }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{model.name}</div>
                  <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
                    {model.quantization} · {model.size} · {(model.context_length ?? 0).toLocaleString()} ctx
                  </div>
                </div>
                {model.tokens_per_sec != null && (
                  <span className="text-[12px]" style={{ fontFamily: "var(--font-mono)", color: "var(--fg-secondary)" }}>
                    {model.tokens_per_sec} tok/s
                  </span>
                )}
                <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: "var(--success-subtle)", color: "var(--success)" }}>
                  {model.status === "ready" ? "Ready" : "Downloading"}
                </span>
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-muted)]"
                  style={{ color: "var(--destructive)" }}
                  onClick={() => deleteMutation.mutate(model.id)}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Available to download */}
      <div className="mb-8">
        <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--fg-muted)" }}>Available Models</h3>
        <div className="flex flex-col gap-2">
          {AVAILABLE_MODELS.map((model) => (
            <div key={model.name} className="flex items-center gap-4 rounded-lg border px-5 py-3" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--bg-muted)" }}>
                <Cpu size={16} style={{ color: "var(--fg-muted)" }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{model.name}</div>
                <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>{model.family} · {model.size}</div>
              </div>
              <button className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors" style={{ borderColor: "var(--border)", color: "var(--fg-secondary)" }}>
                <Download size={12} /> Download
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Test prompt */}
      <div>
        <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--fg-muted)" }}>Test Prompt</h3>
        <div className="rounded-lg border" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          <div className="flex items-center gap-3 border-b px-4 py-2" style={{ borderColor: "var(--border-subtle)" }}>
            <select
              value={activeModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="rounded border px-2 py-1 text-[12px]"
              style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
            >
              {models.length === 0 && <option value="">No models available</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="p-4">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Enter a prompt to test the local model..."
              rows={3}
              className="w-full resize-none border-none bg-transparent text-sm outline-none"
              style={{ color: "var(--fg)", fontFamily: "var(--font-body)" }}
            />
          </div>
          {output && (
            <div className="border-t px-4 py-3" style={{ borderColor: "var(--border-subtle)" }}>
              <pre className="text-[13px] whitespace-pre-wrap" style={{ color: "var(--fg-secondary)", fontFamily: "var(--font-mono)" }}>{output}</pre>
            </div>
          )}
          <div className="flex justify-end border-t px-4 py-2" style={{ borderColor: "var(--border-subtle)" }}>
            <button
              onClick={() => setOutput("Local AI runtime not yet available. This feature is coming in a future release.")}
              disabled={!prompt.trim()}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
              style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
            >
              <Play size={12} /> Generate
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoTile({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string }) {
  return (
    <div className="rounded-lg border px-4 py-3" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
      <div className="mb-1 flex items-center gap-2">
        <Icon size={13} style={{ color: "var(--fg-muted)" }} />
        <span className="text-[11px] font-medium" style={{ color: "var(--fg-muted)" }}>{label}</span>
      </div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}
