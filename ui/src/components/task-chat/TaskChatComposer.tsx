import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
} from "react";
import { cn } from "@/lib/utils";
import { AlertTriangle, ArrowUp, Check, ChevronDown, Loader2, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { nextWorkMode, workModeMetaFor, workModeMetaList } from "@/lib/work-mode-meta";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";
import type { IssueAttachment, IssueWorkMode } from "@paperclipai/shared";

/** Structurally identical to IssueChatThread's module-private CommentReassignment. */
interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

interface TaskChatComposerProps {
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void> | void;
  workMode: IssueWorkMode;
  onWorkModeChange?: (mode: IssueWorkMode) => Promise<void> | void;
  disabled?: boolean;
  disabledReason?: string | null;
  placeholder?: string;
  /** Preferred upload path: attaches the file to the task (mirrors legacy). */
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  /** Fallback upload path: returns a URL for inline image markdown. */
  onImageUpload?: (file: File) => Promise<string>;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  issueStatus?: string;
}

/** Per-mode hue token (see ui/src/index.css `--tc-mode-*`). */
const MODE_HUE: Partial<Record<IssueWorkMode, string>> = {
  standard: "var(--tc-mode-agent)",
  planning: "var(--tc-mode-plan)",
  ask: "var(--tc-mode-ask)",
};

function modeHue(mode: IssueWorkMode): string {
  return MODE_HUE[mode] ?? "var(--tc-mode-agent)";
}

const MODE_DESCRIPTION: Partial<Record<IssueWorkMode, string>> = {
  standard: "Make changes and run work",
  planning: "Draft a plan before acting",
  ask: "Answer questions only, no changes",
};

/** v7 per-mode placeholder copy; `{agent}` is the pending assignee's name. */
function modePlaceholder(mode: IssueWorkMode, agentName: string): string {
  switch (mode) {
    case "planning":
      return `Plan with ${agentName} — shapes the plan doc, no code changes…`;
    case "ask":
      return `Ask ${agentName} a question — read-only, nothing runs…`;
    default:
      return `Message ${agentName} — describe what you want done…`;
  }
}

type ComposerAttachment = {
  id: string;
  name: string;
  status: "uploading" | "attached" | "error";
  error?: string;
  /** Object URL for an immediate thumbnail while (and after) uploading. */
  previewUrl?: string;
  isImage?: boolean;
};

/** Local duplicate of IssueChatThread's module-private helper (same rule). */
function shouldImplicitlyReopenComment(issueStatus: string | undefined, assigneeValue: string) {
  const resumesToTodo = issueStatus === "done" || issueStatus === "cancelled" || issueStatus === "blocked";
  return resumesToTodo && assigneeValue.startsWith("agent:");
}

function parseAssigneeValue(value: string): CommentReassignment | undefined {
  if (value.startsWith("agent:")) {
    const id = value.slice("agent:".length);
    return id ? { assigneeAgentId: id, assigneeUserId: null } : undefined;
  }
  if (value.startsWith("user:")) {
    const id = value.slice("user:".length);
    return id ? { assigneeAgentId: null, assigneeUserId: id } : undefined;
  }
  return undefined;
}

function hasFilePayload(evt: ReactDragEvent<HTMLDivElement>) {
  return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Composer for the redesigned thread (v7 spec): textarea over a 32px comp-bar
 * of [attach] [mode chip] … [assignee] [send]. The mode chip is a status-chip
 * rectangle carrying the pending mode's hue; the composer chrome itself stays
 * neutral. Shift+Tab cycles modes; the picked mode is applied on submit.
 * Attachments upload via `onAttachImage` (or the inline `onImageUpload`
 * fallback) from the + button, paste, or drag-drop.
 */
export function TaskChatComposer({
  onAdd,
  workMode,
  onWorkModeChange,
  disabled = false,
  disabledReason,
  placeholder,
  onAttachImage,
  onImageUpload,
  enableReassign = false,
  reassignOptions,
  currentAssigneeValue = "",
  issueStatus,
}: TaskChatComposerProps) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingMode, setPendingMode] = useState<IssueWorkMode>(workMode);
  const [pendingAssignee, setPendingAssignee] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlsRef = useRef<Set<string>>(new Set());

  // Object URLs created for image previews must be revoked or they leak the
  // underlying blobs for the page's lifetime.
  useEffect(() => {
    const urls = previewUrlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  function releasePreview(url: string | undefined) {
    if (!url) return;
    URL.revokeObjectURL(url);
    previewUrlsRef.current.delete(url);
  }

  const modeMeta = workModeMetaFor(pendingMode);
  const canAcceptFiles = Boolean(onAttachImage || onImageUpload);
  const showAssignee = Boolean(enableReassign && reassignOptions && reassignOptions.length > 0);
  const assigneeValue = pendingAssignee ?? currentAssigneeValue;
  const assigneeLabel =
    reassignOptions?.find((o) => o.id === assigneeValue)?.label ?? "Unassigned";
  const assigneeName = assigneeLabel === "Unassigned" ? "the agent" : assigneeLabel;
  const effectivePlaceholder = placeholder ?? modePlaceholder(pendingMode, assigneeName);

  function insertReference(name: string, url: string, asImage: boolean) {
    const safeName = name.replace(/[[\]]/g, "\\$&");
    const markdown = asImage ? `![${safeName}](${url})` : `[${safeName}](${url})`;
    setBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
  }

  async function attachFile(file: File) {
    const id = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    const isImage = file.type.startsWith("image/");
    // Create the preview up front so the thumbnail appears while uploading.
    const previewUrl =
      isImage && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
    if (previewUrl) previewUrlsRef.current.add(previewUrl);
    setAttachments((prev) => [
      ...prev,
      { id, name: file.name, status: "uploading", previewUrl, isImage: isImage || undefined },
    ]);
    try {
      if (onAttachImage) {
        const attachment = await onAttachImage(file);
        const name = attachment?.originalFilename ?? file.name;
        if (attachment?.contentPath) {
          insertReference(name, attachment.contentPath, file.type.startsWith("image/"));
        }
        setAttachments((prev) =>
          prev.map((item) => (item.id === id ? { ...item, name, status: "attached" } : item)),
        );
      } else if (onImageUpload && file.type.startsWith("image/")) {
        const url = await onImageUpload(file);
        insertReference(file.name, url, true);
        setAttachments((prev) =>
          prev.map((item) => (item.id === id ? { ...item, status: "attached" } : item)),
        );
      } else {
        setAttachments((prev) =>
          prev.map((item) =>
            item.id === id
              ? { ...item, status: "error", error: "This file type cannot be attached here" }
              : item,
          ),
        );
      }
    } catch (err) {
      setAttachments((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, status: "error", error: err instanceof Error ? err.message : "Upload failed" }
            : item,
        ),
      );
    }
  }

  async function attachFiles(files: Iterable<File>) {
    for (const file of files) {
      await attachFile(file);
    }
  }

  function handleFileInputChange(evt: ChangeEvent<HTMLInputElement>) {
    const files = evt.target.files;
    if (files && files.length > 0) void attachFiles(Array.from(files));
    evt.target.value = "";
  }

  function handlePaste(evt: ReactClipboardEvent<HTMLTextAreaElement>) {
    if (!canAcceptFiles) return;
    const files = Array.from(evt.clipboardData?.files ?? []);
    if (files.length === 0) return;
    evt.preventDefault();
    void attachFiles(files);
  }

  function handleFileDragEnter(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleFileDragOver(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = "copy";
  }

  function handleFileDragLeave(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function handleFileDrop(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const files = evt.dataTransfer?.files;
    if (files && files.length > 0) void attachFiles(Array.from(files));
  }

  async function submit() {
    const trimmed = body.trim();
    if (!trimmed || submitting || disabled) return;

    const hasReassignment = showAssignee && assigneeValue !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseAssigneeValue(assigneeValue) : undefined;
    const reopen = shouldImplicitlyReopenComment(issueStatus, assigneeValue) ? true : undefined;

    setSubmitting(true);
    setBody("");
    try {
      if (pendingMode !== workMode && onWorkModeChange) {
        await onWorkModeChange(pendingMode);
      }
      await onAdd(trimmed, reopen, reassignment);
      setAttachments((prev) => {
        for (const item of prev) releasePreview(item.previewUrl);
        return [];
      });
      setPendingAssignee(null);
    } catch {
      setBody(trimmed); // restore on failure
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-input bg-card p-2 shadow-(--shadow-extract-7) transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15",
        isDragOver && "ring-2 ring-primary/40",
      )}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter posts; plain Enter inserts a newline (Enter alone
          // was too easy to trip while drafting).
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
            return;
          }
          if (e.key === "Tab" && e.shiftKey) {
            e.preventDefault();
            setPendingMode((mode) => nextWorkMode(mode));
          }
        }}
        onPaste={handlePaste}
        disabled={disabled}
        placeholder={disabled ? (disabledReason ?? "Composer disabled") : effectivePlaceholder}
        rows={2}
        className="w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
        data-testid="task-chat-composer-input"
      />

      {attachments.length > 0 ? (
        <div className="mb-1 flex flex-wrap gap-1 px-1" data-testid="task-chat-composer-attachments">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className={cn(
                "inline-flex min-w-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
                attachment.status === "error"
                  ? "border-destructive/50 bg-destructive/10 text-destructive"
                  : "border-border bg-muted/30 text-muted-foreground",
              )}
            >
              {attachment.isImage && attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt=""
                  className="size-10 shrink-0 rounded object-cover"
                />
              ) : null}
              {attachment.status === "uploading" ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
              ) : attachment.status === "error" ? (
                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
              ) : (
                <Check className="h-3 w-3 shrink-0" aria-hidden />
              )}
              <span className="max-w-40 truncate font-medium text-foreground">{attachment.name}</span>
              <span className="shrink-0">
                ·{" "}
                {attachment.status === "uploading"
                  ? "Uploading…"
                  : attachment.status === "error"
                    ? (attachment.error ?? "Upload failed")
                    : "Attached"}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-1 flex items-center gap-2">
        {canAcceptFiles ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileInputChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              title="Attach file"
              aria-label="Attach file"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              data-testid="task-chat-composer-attach"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled || !onWorkModeChange}
              className="status-chip flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:opacity-50"
              style={{ "--sc": modeHue(pendingMode) } as CSSProperties}
              data-testid="task-chat-composer-mode"
              data-pending-work-mode={pendingMode}
            >
              {modeMeta.label}
              <ChevronDown className="h-3 w-3" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            {workModeMetaList().map((m) => {
              const Icon = m.icon;
              const selected = m.value === pendingMode;
              return (
                <DropdownMenuItem
                  key={m.value}
                  onSelect={() => setPendingMode(m.value)}
                  style={
                    selected
                      ? { backgroundColor: `color-mix(in srgb, ${modeHue(m.value)} 12%, transparent)` }
                      : undefined
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" style={{ color: modeHue(m.value) }} aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{m.label}</span>
                    <span className="text-xs text-muted-foreground">{MODE_DESCRIPTION[m.value] ?? ""}</span>
                  </span>
                  {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />

        {showAssignee ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                data-testid="task-chat-composer-assignee"
              >
                <span className="max-w-40 truncate">{assigneeLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {(reassignOptions ?? []).map((option) => (
                <DropdownMenuItem key={option.id} onSelect={() => setPendingAssignee(option.id)}>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.id === assigneeValue ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={disabled || submitting || body.trim().length === 0}
          title="Send (⌘+Enter)"
          aria-label="Send"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-transform hover:scale-105 disabled:scale-100 disabled:bg-muted disabled:text-muted-foreground"
          data-testid="task-chat-composer-send"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <ArrowUp className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}
