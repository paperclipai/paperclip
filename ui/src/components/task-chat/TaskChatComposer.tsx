import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
} from "react";
import { cn } from "@/lib/utils";
import { DRAFT_DEBOUNCE_MS, clearDraft, loadDraft, saveDraft } from "@/lib/composer-draft";
import { ArrowUp, Check, ChevronDown, Loader2, Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { fileKindForName, formatFileSize } from "./task-chat-attachments";
import { MarkdownEditor, type MarkdownEditorRef } from "@/components/MarkdownEditor";
import { nextWorkMode, workModeMetaFor, workModeMetaList } from "@/lib/work-mode-meta";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";
import type { MentionOption } from "@/components/MarkdownEditor";
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
  /** Mentionable entities for the editor's @-autocomplete. */
  mentions?: MentionOption[];
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  issueStatus?: string;
  /** Mobile document-flow host: 16px editor text so iOS doesn't zoom on focus. */
  mobile?: boolean;
  /** Storage key used to restore, persist, and clear this task's text draft. */
  draftKey?: string;
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
  size?: number;
  status: "uploading" | "attached" | "error";
  error?: string;
  /** Set once uploaded; the submit path appends `[name](contentPath)` lines. */
  contentPath?: string;
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

function escapeMarkdownLabel(name: string): string {
  return name.replace(/[[\]]/g, "\\$&");
}

/**
 * Composer for the redesigned thread (v7 spec): the shared MarkdownEditor
 * (rich lists, @-mentions, /-commands, inline pasted images) over a 32px
 * comp-bar of [attach] [mode chip] … [assignee] [send]. The mode chip is a
 * status-chip rectangle carrying the pending mode's hue; the composer chrome
 * itself stays neutral. Shift+Tab cycles modes (captured before Lexical);
 * Cmd/Ctrl+Enter posts via the editor's native onSubmit; plain Enter stays a
 * newline / next list item. Pasted or dropped images upload through
 * `onAttachImage` (or the `onImageUpload` fallback) and land inline at the
 * caret via the editor's image plugin; non-image files render as shadcn
 * base/attachment chips (kind icon · name · size, remove ×, uploading/error
 * states) between the editor and the comp-bar.
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
  mentions,
  enableReassign = false,
  reassignOptions,
  currentAssigneeValue = "",
  issueStatus,
  mobile = false,
  draftKey,
}: TaskChatComposerProps) {
  const [body, setBody] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
  const [submitting, setSubmitting] = useState(false);
  const [pendingMode, setPendingMode] = useState<IssueWorkMode>(workMode);
  const [pendingAssignee, setPendingAssignee] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const pendingAssigneeRef = useRef(pendingAssignee);
  pendingAssigneeRef.current = pendingAssignee;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (draftKey) saveDraft(draftKey, bodyRef.current);
    };
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    const flushDraft = () => saveDraft(draftKey, bodyRef.current);
    window.addEventListener("beforeunload", flushDraft);
    return () => window.removeEventListener("beforeunload", flushDraft);
  }, [draftKey]);

  const modeMeta = workModeMetaFor(pendingMode);
  const canAcceptFiles = Boolean(onAttachImage || onImageUpload);
  const showAssignee = Boolean(enableReassign && reassignOptions && reassignOptions.length > 0);
  const assigneeValue = pendingAssignee ?? currentAssigneeValue;
  const assigneeLabel =
    reassignOptions?.find((o) => o.id === assigneeValue)?.label ?? "Unassigned";
  const assigneeName = assigneeLabel === "Unassigned" ? "the agent" : assigneeLabel;
  const effectivePlaceholder = placeholder ?? modePlaceholder(pendingMode, assigneeName);

  /** Upload an image and return its URL for inline `![](src)` markdown. */
  async function uploadInlineImage(file: File): Promise<string> {
    if (onAttachImage) {
      const attachment = await onAttachImage(file);
      if (attachment?.contentPath) return attachment.contentPath;
      throw new Error("Upload did not return a file URL");
    }
    if (onImageUpload) return onImageUpload(file);
    throw new Error("This file type cannot be attached here");
  }

  /** Non-image files: attach to the task and track in the chip row. */
  async function attachNonImageFile(file: File) {
    const id = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    setAttachments((prev) => [...prev, { id, name: file.name, size: file.size, status: "uploading" }]);
    try {
      if (!onAttachImage) {
        setAttachments((prev) =>
          prev.map((item) =>
            item.id === id
              ? { ...item, status: "error", error: "This file type cannot be attached here" }
              : item,
          ),
        );
        return;
      }
      const attachment = await onAttachImage(file);
      const name = attachment?.originalFilename ?? file.name;
      setAttachments((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, name, status: "attached", contentPath: attachment?.contentPath }
            : item,
        ),
      );
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

  /** Images picked from the + button go inline at the caret, like paste/drop. */
  async function attachPickedFile(file: File) {
    if (!file.type.startsWith("image/")) {
      await attachNonImageFile(file);
      return;
    }
    const id = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    try {
      const url = await uploadInlineImage(file);
      editorRef.current?.insertMarkdown(`![${escapeMarkdownLabel(file.name)}](${url})`);
    } catch (err) {
      setAttachments((prev) => [
        ...prev,
        {
          id,
          name: file.name,
          size: file.size,
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        },
      ]);
    }
  }

  function handleFileInputChange(evt: ChangeEvent<HTMLInputElement>) {
    const files = evt.target.files;
    if (files && files.length > 0) {
      void (async () => {
        for (const file of Array.from(files)) await attachPickedFile(file);
      })();
    }
    evt.target.value = "";
  }

  /**
   * Pasted image files fall through to the editor's image plugin (inline at
   * the caret); non-image files are attached to the task here. Only swallow
   * the paste when it carries no images the plugin should handle.
   */
  function handlePasteCapture(evt: ReactClipboardEvent<HTMLDivElement>) {
    if (!canAcceptFiles) return;
    const files = Array.from(evt.clipboardData?.files ?? []);
    if (files.length === 0) return;
    const nonImages = files.filter((file) => !file.type.startsWith("image/"));
    if (nonImages.length === 0) return;
    if (nonImages.length === files.length) {
      evt.preventDefault();
      evt.stopPropagation();
    }
    void (async () => {
      for (const file of nonImages) await attachNonImageFile(file);
    })();
  }

  // Uploaded file references ride along as trailing `[name](contentPath)`
  // lines — the bubble renderer folds those link-only lines back into chips.
  const attachedRefs = attachments.filter(
    (item) => item.status === "attached" && item.contentPath,
  );
  // Sending mid-upload would silently drop the pending file from the comment;
  // sending past a failed chip would discard the file the user selected and
  // clear its error state, so both hold submission until resolved or removed.
  const uploadPending = attachments.some((item) => item.status === "uploading");
  const uploadFailed = attachments.some((item) => item.status === "error");

  async function submit() {
    const submittedBody = bodyRef.current;
    const submittedAttachments = attachmentsRef.current;
    const submittedAssignee = pendingAssigneeRef.current;
    const trimmed = submittedBody.trim();
    if (
      (!trimmed && attachedRefs.length === 0) ||
      uploadPending ||
      uploadFailed ||
      submitting ||
      disabled
    )
      return;

    const refLines = attachedRefs
      .map((item) => `[${escapeMarkdownLabel(item.name)}](${item.contentPath})`)
      .join("\n");
    const fullBody = [trimmed, refLines].filter(Boolean).join("\n\n");
    const hasReassignment = showAssignee && assigneeValue !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseAssigneeValue(assigneeValue) : undefined;
    const reopen = shouldImplicitlyReopenComment(issueStatus, assigneeValue) ? true : undefined;

    setSubmitting(true);
    try {
      if (pendingMode !== workMode && onWorkModeChange) {
        await onWorkModeChange(pendingMode);
      }
      await onAdd(fullBody, reopen, reassignment);
      if (bodyRef.current === submittedBody) {
        bodyRef.current = "";
        if (draftTimer.current) {
          clearTimeout(draftTimer.current);
          draftTimer.current = null;
        }
        if (draftKey) clearDraft(draftKey);
        setBody("");
      } else if (draftKey) {
        // The editor stays writable while the request is pending. Preserve
        // text entered after this submission started as the next draft.
        saveDraft(draftKey, bodyRef.current);
      }
      if (attachmentsRef.current === submittedAttachments) {
        setAttachments([]);
      }
      if (pendingAssigneeRef.current === submittedAssignee) {
        setPendingAssignee(null);
      }
    } catch {
      // Keep the body and its draft available for retry.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-input bg-card p-2 shadow-(--shadow-extract-7) transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15",
      )}
      onKeyDownCapture={(e) => {
        // Shift+Tab cycles the pending mode; captured on the wrapper so it
        // wins over Lexical's list-outdent binding inside the editor.
        if (disabled) return;
        if (e.key === "Tab" && e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          setPendingMode((mode) => nextWorkMode(mode));
        }
      }}
      onPasteCapture={handlePasteCapture}
    >
      <div data-testid="task-chat-composer-input">
        <MarkdownEditor
          ref={editorRef}
          value={body}
          onChange={setBody}
          placeholder={disabled ? (disabledReason ?? "Composer disabled") : effectivePlaceholder}
          readOnly={disabled}
          mentions={mentions}
          onSubmit={() => void submit()}
          imageUploadHandler={canAcceptFiles ? uploadInlineImage : undefined}
          onDropFile={canAcceptFiles ? attachNonImageFile : undefined}
          bordered={false}
          className={cn(disabled && "opacity-60")}
          contentClassName={
            mobile
              ? "max-h-(--sz-28dvh) min-h-(--sz-48px) overflow-y-auto px-1 py-1 text-base scrollbar-auto-hide"
              : "max-h-(--sz-28dvh) min-h-(--sz-48px) overflow-y-auto px-1 py-1 text-sm scrollbar-auto-hide"
          }
        />
      </div>

      {attachments.length > 0 ? (
        <AttachmentGroup className="mb-1 px-1" data-testid="task-chat-composer-attachments">
          {attachments.map((attachment) => {
            const kind = fileKindForName(attachment.name);
            const KindIcon = kind.icon;
            const sizeLabel = formatFileSize(attachment.size);
            return (
              <Attachment
                key={attachment.id}
                size="sm"
                state={
                  attachment.status === "uploading"
                    ? "uploading"
                    : attachment.status === "error"
                      ? "error"
                      : "done"
                }
              >
                <AttachmentMedia>
                  {attachment.status === "uploading" ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <KindIcon aria-hidden />
                  )}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle className="max-w-48">{attachment.name}</AttachmentTitle>
                  <AttachmentDescription className="max-w-48">
                    {attachment.status === "uploading"
                      ? "Uploading…"
                      : attachment.status === "error"
                        ? (attachment.error ?? "Upload failed")
                        : [kind.label, sizeLabel].filter(Boolean).join(" · ")}
                  </AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() =>
                      setAttachments((prev) => prev.filter((item) => item.id !== attachment.id))
                    }
                  >
                    <X aria-hidden />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            );
          })}
        </AttachmentGroup>
      ) : null}

      <div className="mt-1 flex items-center gap-2">
        {canAcceptFiles ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
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
          disabled={
            disabled ||
            submitting ||
            uploadPending ||
            uploadFailed ||
            (body.trim().length === 0 && attachedRefs.length === 0)
          }
          title={
            uploadPending
              ? "Waiting for upload to finish"
              : uploadFailed
                ? "Remove the failed attachment to send"
                : "Send (⌘+Enter)"
          }
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
