import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { File, Loader2, Paperclip, Send, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select as SelectPrimitive } from "radix-ui";
import { CheckIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  chatApi,
  type AvailableModel,
  type ChatAttachmentSummary,
  type ChatMode,
  type EffortLevel,
  type PermissionMode,
} from "../api/chat";
import { cn } from "../lib/utils";

/**
 * Decode an `adapter:<type>:<modelId>` id into the bare model + adapter
 * source for display. Returns the raw id when it isn't adapter-encoded.
 */
function formatModelDisplay(id: string): { model: string; adapter: string | null } {
  if (!id.startsWith("adapter:")) return { model: id, adapter: null };
  const rest = id.slice("adapter:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return { model: id, adapter: null };
  return { model: rest.slice(sep + 1), adapter: rest.slice(0, sep) };
}

interface PendingUpload {
  /** Stable id to track the chip while the upload is in flight. */
  localId: string;
  name: string;
  size: number;
  mediaType: string;
  /** Object URL for image previews; null until we know it's an image. */
  previewUrl: string | null;
  status: "uploading" | "done" | "error";
  error?: string;
  /** Set once the server returns the attachment id. */
  attachment?: ChatAttachmentSummary;
}

interface Props {
  sessionId: string | null;
  mode: ChatMode;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  model: string;
  streaming: boolean;
  onSend: (text: string, attachmentIds: string[]) => void;
  onStopAndSend?: (text: string, attachmentIds: string[]) => void;
  onAbort: () => void;
  onPatch: (patch: {
    mode?: ChatMode;
    permissionMode?: PermissionMode;
    effort?: EffortLevel;
    model?: string;
  }) => void;
}

const MAX_ATTACHMENTS = 8;

interface ModelGroup {
  key: string;
  label: string;
  tagline: string;
  items: AvailableModel[];
}

const PROVIDER_INFO: Record<string, { label: string; tagline: string; order: number }> = {
  anthropic: {
    label: "Anthropic",
    tagline: "Claude API — uses ANTHROPIC_API_KEY.",
    order: 10,
  },
  openai: {
    label: "OpenAI",
    tagline: "GPT API — uses OPENAI_API_KEY.",
    order: 20,
  },
  gemini: {
    label: "Google Gemini",
    tagline: "Gemini API — uses GEMINI_API_KEY.",
    order: 30,
  },
  ollama: {
    label: "Ollama",
    tagline: "Local models — no network, no API keys.",
    order: 40,
  },
  claude_local: {
    label: "Claude (local CLI)",
    tagline: "Routed via your local Claude CLI session — no direct API key.",
    order: 50,
  },
  codex_local: {
    label: "OpenAI Codex (local CLI)",
    tagline: "Routed via your local OpenAI Codex CLI session.",
    order: 60,
  },
  aider_local: {
    label: "Aider (local CLI)",
    tagline: "Aider CLI driving local Ollama models.",
    order: 70,
  },
  gemini_local: {
    label: "Gemini (local CLI)",
    tagline: "Routed via your local Gemini CLI session — no direct API key.",
    order: 80,
  },
  ollama_local: {
    label: "Ollama (local CLI)",
    tagline: "Local Ollama models exposed through the Ollama CLI adapter.",
    order: 90,
  },
  opencode_local: {
    label: "OpenCode (local CLI)",
    tagline: "Routed via the OpenCode CLI — multi-provider gateway running on your machine.",
    order: 100,
  },
  cursor: {
    label: "Cursor",
    tagline: "Models exposed via your Cursor session — covers Anthropic, OpenAI, Gemini, xAI, etc.",
    order: 110,
  },
};

function prettifyAdapterKey(key: string): string {
  // Turn "foo_bar_local" into "Foo Bar (local CLI)" so unknown adapters
  // don't render as raw snake_case ALL CAPS in the dropdown header.
  const stripped = key.endsWith("_local") ? key.slice(0, -"_local".length) : key;
  const titled = stripped
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return key.endsWith("_local") ? `${titled} (local CLI)` : titled;
}

function infoForGroupKey(key: string): { label: string; tagline: string; order: number } {
  return (
    PROVIDER_INFO[key] ?? {
      label: prettifyAdapterKey(key),
      tagline: key.endsWith("_local")
        ? "Routed via a local CLI adapter."
        : "Additional provider.",
      order: 1000,
    }
  );
}

function groupModels(models: AvailableModel[]): ModelGroup[] {
  const buckets = new Map<string, AvailableModel[]>();
  for (const m of models) {
    const key = m.source ?? m.provider;
    const list = buckets.get(key);
    if (list) list.push(m);
    else buckets.set(key, [m]);
  }
  return [...buckets.entries()]
    .map(([key, items]): ModelGroup => {
      const info = infoForGroupKey(key);
      return { key, label: info.label, tagline: info.tagline, items };
    })
    .sort((a, b) => {
      const ao = infoForGroupKey(a.key).order;
      const bo = infoForGroupKey(b.key).order;
      if (ao !== bo) return ao - bo;
      return a.label.localeCompare(b.label);
    });
}

function ModeSelectItem({
  value,
  label,
  description,
}: {
  value: string;
  label: string;
  description: string;
}) {
  return (
    <SelectPrimitive.Item
      value={value}
      className="focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default flex-col items-start gap-0.5 rounded-sm py-2 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2 top-2.5 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
      <span className="text-xs leading-snug text-muted-foreground">{description}</span>
    </SelectPrimitive.Item>
  );
}

export function ClippyComposer({
  sessionId,
  mode,
  permissionMode,
  effort,
  model,
  streaming,
  onSend,
  onStopAndSend,
  onAbort,
  onPatch,
}: Props) {
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const modelsQuery = useQuery({
    queryKey: ["clippy", "models"],
    queryFn: () => chatApi.listModels().then((r) => r.models),
    staleTime: 60_000,
  });
  const models = modelsQuery.data ?? [];

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Revoke any object URLs when uploads list changes / unmounts.
  useEffect(() => {
    return () => {
      uploads.forEach((u) => {
        if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ingestFiles = async (files: FileList | File[]) => {
    if (!sessionId) return;
    const list = Array.from(files);
    const slotsLeft = Math.max(0, MAX_ATTACHMENTS - uploads.length);
    const toUpload = list.slice(0, slotsLeft);
    for (const file of toUpload) {
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const isImage = file.type.startsWith("image/");
      const previewUrl = isImage ? URL.createObjectURL(file) : null;

      // Pre-flight checks the server would otherwise reject — show a clearer
      // message inline instead of a generic "API route not found" / 422.
      const preflightError = preflightRejectionFor(file);
      if (preflightError) {
        setUploads((prev) => [
          ...prev,
          {
            localId,
            name: file.name || (isImage ? "image" : "file"),
            size: file.size,
            mediaType: file.type || "application/octet-stream",
            previewUrl,
            status: "error",
            error: preflightError,
          },
        ]);
        continue;
      }

      setUploads((prev) => [
        ...prev,
        {
          localId,
          name: file.name || (isImage ? "image" : "file"),
          size: file.size,
          mediaType: file.type || "application/octet-stream",
          previewUrl,
          status: "uploading",
        },
      ]);
      try {
        const att = await chatApi.uploadAttachment(sessionId, file);
        setUploads((prev) =>
          prev.map((u) =>
            u.localId === localId ? { ...u, status: "done", attachment: att } : u,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUploads((prev) =>
          prev.map((u) =>
            u.localId === localId ? { ...u, status: "error", error: msg } : u,
          ),
        );
      }
    }
  };

  const removeUpload = (localId: string) => {
    setUploads((prev) => {
      const u = prev.find((p) => p.localId === localId);
      if (u?.previewUrl) URL.revokeObjectURL(u.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  };

  const submit = (opts: { force?: boolean } = {}) => {
    const trimmed = text.trim();
    const ready = uploads.filter((u) => u.status === "done" && u.attachment);
    if (!trimmed && ready.length === 0) return;
    if (!opts.force && streaming) return;
    if (uploads.some((u) => u.status === "uploading")) return;
    const ids = ready.map((u) => u.attachment!.id);
    setText("");
    setUploads([]);
    if (opts.force && onStopAndSend) {
      onStopAndSend(trimmed, ids);
    } else {
      onSend(trimmed, ids);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition: CJK and other multi-keystroke input methods commit a
    // candidate via Enter. Don't treat that Enter as a submit.
    const native = e.nativeEvent as KeyboardEvent;
    if (native.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!sessionId) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void ingestFiles(files);
    }
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!sessionId) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dropDepth.current += 1;
    setDropping(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (dropDepth.current === 0) setDropping(false);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dropDepth.current = 0;
    setDropping(false);
    if (!sessionId) return;
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      void ingestFiles(files);
    }
  };

  const anyUploading = uploads.some((u) => u.status === "uploading");
  const hasContent = !!text.trim() || uploads.filter((u) => u.status === "done").length > 0;
  const sendDisabled =
    streaming || anyUploading || !hasContent;
  const canStopAndSend = streaming && hasContent && !anyUploading && !!onStopAndSend;

  return (
    <div
      className={cn(
        "relative border-t border-border bg-background px-3 pb-3 pt-2",
        dropping && "ring-2 ring-inset ring-primary/60",
      )}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/10">
          <div className="rounded-md border border-primary/40 bg-background px-3 py-2 text-xs font-medium">
            Drop to attach
          </div>
        </div>
      )}
      <div className="mx-auto max-w-3xl">
        {uploads.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {uploads.map((u) => (
              <UploadChip key={u.localId} upload={u} onRemove={() => removeUpload(u.localId)} />
            ))}
          </div>
        )}
        <div className="rounded-md border border-border focus-within:ring-1 focus-within:ring-ring">
          <Textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="Ask Clippy anything — drop or paste images and files, Shift+Enter for newline"
            rows={3}
            className="min-h-[64px] resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
          />
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-2 py-1.5 text-xs">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={!sessionId || streaming || uploads.length >= MAX_ATTACHMENTS}
              title="Attach file"
              aria-label="Attach file"
              type="button"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void ingestFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <Select
              value={mode}
              onValueChange={(v) => onPatch({ mode: v as ChatMode })}
              disabled={streaming}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <SelectTrigger
                    size="sm"
                    className="h-7 w-auto gap-1 px-2 text-xs"
                    aria-label={`Chat mode: ${mode === "agent" ? "Agent" : "Chat"}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-left">
                  {mode === "agent" ? (
                    <>
                      <div className="font-medium">Agent mode</div>
                      <div className="mt-0.5 opacity-80">
                        Full tool access — plugin tools, Paperclip state, and external services.
                        Mutating tools may require approval.
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="font-medium">Chat mode</div>
                      <div className="mt-0.5 opacity-80">
                        Read-only conversation. No tools, no state changes, no external calls.
                        Switch to Agent to let Clippy act on your behalf.
                      </div>
                    </>
                  )}
                </TooltipContent>
              </Tooltip>
              <SelectContent className="w-72">
                <ModeSelectItem
                  value="chat"
                  label="Chat"
                  description="Read-only conversation. The model can answer questions about Paperclip but can't call tools, mutate state, or hit external services."
                />
                <ModeSelectItem
                  value="agent"
                  label="Agent"
                  description="Full tool access. The model can use plugin tools (e.g. 3cx-tools, email-tools), read/write issues, and call external services on your behalf. Mutating tools may require approval."
                />
              </SelectContent>
            </Select>
            {mode === "agent" && (
              <Select
                value={permissionMode}
                onValueChange={(v) => onPatch({ permissionMode: v as PermissionMode })}
                disabled={streaming}
              >
                <SelectTrigger size="sm" className="h-7 w-auto gap-1 px-2 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">Ask permission</SelectItem>
                  <SelectItem value="bypass">Bypass permissions</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Select
              value={model}
              onValueChange={(v) => onPatch({ model: v })}
              disabled={streaming || (models.length === 0 && !model)}
            >
              <SelectTrigger size="sm" className="h-7 w-auto gap-1 px-2 text-xs">
                <SelectValue placeholder={model || "Pick a model"} />
              </SelectTrigger>
              <SelectContent>
                {models.length === 0 ? (
                  <SelectItem value={model || "no-model"} disabled>
                    {model || "No models available"}
                  </SelectItem>
                ) : (
                  <>
                    {/* If the session's persisted model isn't in the discovered
                        list (e.g. an adapter was disabled, or a stale id from
                        before the adapter:* encoding), still surface it so the
                        user sees what's selected — disabled, with a hint. */}
                    {model && !models.some((m) => m.model === model) && (() => {
                      const display = formatModelDisplay(model);
                      return (
                        <SelectItem value={model} disabled>
                          <span className="font-mono">{display.model}</span>
                          <span className="ml-2 text-[10px] text-muted-foreground">
                            {display.adapter ? `via ${display.adapter} · unavailable` : "unavailable"}
                          </span>
                        </SelectItem>
                      );
                    })()}
                    {groupModels(models).map((group) => (
                      <SelectGroup key={group.key}>
                        <SelectLabel className="px-2 pt-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-foreground">
                          {group.label}
                        </SelectLabel>
                        <div className="px-2 pb-1 text-[10px] leading-snug text-muted-foreground">
                          {group.tagline}
                        </div>
                        {group.items.map((m) => {
                          const isAdapterRouted =
                            m.provider === "adapter" && m.model.startsWith("adapter:");
                          let displayModel = m.model;
                          if (isAdapterRouted) {
                            const rest = m.model.slice("adapter:".length);
                            const sep = rest.indexOf(":");
                            if (sep > 0) displayModel = rest.slice(sep + 1);
                          }
                          return (
                            <SelectItem
                              key={`${m.provider}:${m.model}:${m.source ?? ""}`}
                              value={m.model}
                            >
                              <span className="font-mono">{displayModel}</span>
                            </SelectItem>
                          );
                        })}
                      </SelectGroup>
                    ))}
                  </>
                )}
              </SelectContent>
            </Select>
            <Select
              value={effort}
              onValueChange={(v) => onPatch({ effort: v as EffortLevel })}
              disabled={streaming}
            >
              <SelectTrigger size="sm" className="h-7 w-auto gap-1 px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Effort: Auto</SelectItem>
                <SelectItem value="low">Effort: Low</SelectItem>
                <SelectItem value="medium">Effort: Medium</SelectItem>
                <SelectItem value="high">Effort: High</SelectItem>
              </SelectContent>
            </Select>
            <div className="ml-auto flex items-center gap-1">
              {streaming && (
                <Button size="sm" variant="ghost" onClick={onAbort}>
                  <Square className="mr-1 h-3 w-3" /> Stop
                </Button>
              )}
              {canStopAndSend ? (
                <Button size="sm" onClick={() => submit({ force: true })}>
                  <Send className="mr-1 h-3 w-3" /> Stop & Send
                </Button>
              ) : !streaming && (
                <Button size="sm" onClick={() => submit()} disabled={sendDisabled}>
                  <Send className="mr-1 h-3 w-3" /> Send
                </Button>
              )}
            </div>
          </div>
        </div>
        {models.length === 0 && (
          <div className="mt-2 text-[11px] text-muted-foreground">
            No LLM provider configured. Set <code>ANTHROPIC_API_KEY</code>,{" "}
            <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, or start a local Ollama (
            <code>OLLAMA_HOST</code>) to enable Clippy.
          </div>
        )}
      </div>
    </div>
  );
}

function UploadChip({ upload, onRemove }: { upload: PendingUpload; onRemove: () => void }) {
  const isImage = upload.mediaType.startsWith("image/");
  const errored = upload.status === "error";
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-md border bg-muted/40 p-1.5 pr-2 text-xs",
        errored ? "border-red-300 dark:border-red-900" : "border-border",
      )}
      title={errored ? upload.error : `${upload.name} · ${formatBytes(upload.size)}`}
    >
      {isImage && upload.previewUrl ? (
        <img
          src={upload.previewUrl}
          alt={upload.name}
          className="h-10 w-10 rounded object-cover"
        />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded bg-background">
          <File className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <div className="flex min-w-0 max-w-[150px] flex-col">
        <span className="truncate font-medium">{upload.name}</span>
        <span className="text-[10px] text-muted-foreground">
          {upload.status === "uploading" ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> uploading…
            </span>
          ) : errored ? (
            <span className="text-red-600 dark:text-red-400">{upload.error ?? "upload failed"}</span>
          ) : (
            formatBytes(upload.size)
          )}
        </span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 rounded-full bg-background p-0.5 text-muted-foreground shadow ring-1 ring-border hover:text-foreground"
        title="Remove"
        aria-label="Remove attachment"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Common per-MIME max from the server (10 MB default). Tested client-side so
// the user gets feedback without a round-trip.
const CLIENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Reject the obvious "this won't work" cases before we even hit the server,
 * so the chip's error makes sense. Notably:
 *  - Windows shortcuts (`.lnk`) carry the shortcut metadata, not the target.
 *    Browsers report them as `application/x-ms-shortcut` (or no MIME) and
 *    the server allowlist would reject anyway with a less obvious message.
 *  - Empty / zero-byte drops (folders, broken handoffs).
 */
function preflightRejectionFor(file: File): string | null {
  const name = (file.name ?? "").toLowerCase();
  const mime = (file.type ?? "").toLowerCase();
  if (name.endsWith(".lnk") || mime === "application/x-ms-shortcut") {
    return "Windows shortcuts can't be uploaded — drop the actual file";
  }
  if (name.endsWith(".url") || mime === "application/internet-shortcut") {
    return "Internet shortcuts can't be uploaded — drop the actual file";
  }
  if (file.size === 0) {
    // Folder drops show up as zero-byte entries in some browsers. So do
    // genuinely empty files; either way there's nothing useful to send.
    return "File is empty (folders can't be uploaded — drop a file inside)";
  }
  if (file.size > CLIENT_MAX_BYTES) {
    return `File is too large (${formatBytes(file.size)} > ${formatBytes(CLIENT_MAX_BYTES)})`;
  }
  return null;
}
