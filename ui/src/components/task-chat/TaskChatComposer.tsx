import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { useStreamlinedTaskChatPresentation } from "./presentation-mode";
import {
  DRAFT_DEBOUNCE_MS,
  clearDraft,
  loadDraft,
  saveDraft,
} from "@/lib/composer-draft";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleHelp,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import {
  MarkdownEditor,
  type MarkdownEditorRef,
} from "@/components/MarkdownEditor";
import {
  nextWorkMode,
  workModeMetaFor,
  workModeMetaList,
} from "@/lib/work-mode-meta";
import {
  InlineEntitySelector,
  type InlineEntityOption,
} from "@/components/InlineEntitySelector";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { MentionOption } from "@/components/MarkdownEditor";
import type { IssueAttachment, IssueWorkMode } from "@paperclipai/shared";
import { TaskChatComposerTakeoverActionsContext } from "./TaskChatComposerTakeoverContext";

/** Structurally identical to IssueChatThread's module-private CommentReassignment. */
interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface TaskChatComposerTakeover {
  id: string;
  label: string;
  pendingCount: number;
  content: ReactNode;
  /** Hides the takeover without resolving it; the pending indicator can reopen it. */
  onDismiss: () => void;
  onSkip: () => Promise<void> | void;
  onShowNext?: () => void;
  /** Places Skip inside a structured question form's action row. */
  inlineSkip?: boolean;
  /** Some decision surfaces already provide a non-accept path of their own. */
  hideSkip?: boolean;
}

interface TaskChatComposerProps {
  onAdd: (
    body: string,
    reopen?: boolean,
    reassignment?: CommentReassignment,
  ) => Promise<void> | void;
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
  agentMap?: ReadonlyMap<string, { icon?: string | null }>;
  userProfileMap?: ReadonlyMap<
    string,
    { label: string; image: string | null }
  > | null;
  currentAssigneeValue?: string;
  issueStatus?: string;
  /** Mobile document-flow host: 16px editor text so iOS doesn't zoom on focus. */
  mobile?: boolean;
  /** Storage key used to restore, persist, and clear this task's text draft. */
  draftKey?: string;
  /** When set, the main composer temporarily edits this queued message. */
  queuedEdit?: { commentId: string; body: string; stale?: boolean } | null;
  onSaveQueuedEdit?: (commentId: string, body: string) => Promise<void>;
  onCancelQueuedEdit?: () => void;
  takeover?: TaskChatComposerTakeover | null;
  pendingTakeover?: {
    count: number;
    label?: string;
    onOpen: () => void;
  } | null;
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

function identityInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

function AssigneeIdentityAvatar({
  assigneeValue,
  label,
  agentMap,
  userProfileMap,
  placement,
}: {
  assigneeValue: string;
  label: string;
  agentMap: ReadonlyMap<string, { icon?: string | null }> | undefined;
  userProfileMap:
    | ReadonlyMap<string, { label: string; image: string | null }>
    | null
    | undefined;
  placement: "trigger" | "option";
}) {
  if (assigneeValue.startsWith("agent:")) {
    const agentId = assigneeValue.slice("agent:".length);
    const icon = agentMap?.get(agentId)?.icon ?? "bot";
    return (
      <Avatar
        size="xs"
        className="shrink-0"
        data-assignee-identity={assigneeValue}
        data-assignee-trigger-icon={placement === "trigger" ? icon : undefined}
        data-assignee-option-icon={
          placement === "option" ? assigneeValue : undefined
        }
      >
        <AvatarFallback>
          <AgentIcon icon={icon} className="h-3 w-3" />
        </AvatarFallback>
      </Avatar>
    );
  }

  if (assigneeValue.startsWith("user:")) {
    const userId = assigneeValue.slice("user:".length);
    const profile = userProfileMap?.get(userId);
    const resolvedLabel = profile?.label ?? label;
    return (
      <Avatar
        size="xs"
        className="shrink-0"
        data-assignee-identity={assigneeValue}
        data-assignee-trigger-avatar={
          placement === "trigger" ? userId : undefined
        }
        data-assignee-option-avatar={
          placement === "option" ? assigneeValue : undefined
        }
      >
        {profile?.image ? <AvatarImage src={profile.image} alt="" /> : null}
        <AvatarFallback>{identityInitials(resolvedLabel)}</AvatarFallback>
      </Avatar>
    );
  }

  return null;
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

type QueuedEditBackup = {
  body: string;
  attachments: ComposerAttachment[];
  pendingMode: IssueWorkMode;
  pendingAssignee: string | null;
};

/** Local duplicate of IssueChatThread's module-private helper (same rule). */
function shouldImplicitlyReopenComment(
  issueStatus: string | undefined,
  assigneeValue: string,
) {
  const resumesToTodo =
    issueStatus === "done" ||
    issueStatus === "cancelled" ||
    issueStatus === "blocked";
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
 * borderless filled control carrying the pending mode's hue; the composer chrome
 * itself stays neutral. Cmd/Ctrl+. and Shift+Tab cycle modes (captured before
 * Lexical); Cmd/Ctrl+Enter posts via the editor's native onSubmit; plain Enter
 * stays a newline / next list item. Pasted or dropped images upload through
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
  agentMap,
  userProfileMap,
  currentAssigneeValue = "",
  issueStatus,
  mobile = false,
  draftKey,
  queuedEdit = null,
  onSaveQueuedEdit,
  onCancelQueuedEdit,
  takeover = null,
  pendingTakeover = null,
}: TaskChatComposerProps) {
  const streamlined = useStreamlinedTaskChatPresentation();
  const [body, setBody] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
  const [submitting, setSubmitting] = useState(false);
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const [takeoverHeaderClaimed, setTakeoverHeaderClaimed] = useState(false);
  const [takeoverHeaderSlot, setTakeoverHeaderSlot] =
    useState<HTMLElement | null>(null);
  const [takeoverControlsSlot, setTakeoverControlsSlot] =
    useState<HTMLElement | null>(null);
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
  const queuedEditRef = useRef(queuedEdit);
  queuedEditRef.current = queuedEdit;
  const queuedEditBackupRef = useRef<QueuedEditBackup | null>(null);
  const previousQueuedEditIdRef = useRef<string | null>(null);

  useEffect(() => {
    setTakeoverBusy(false);
    setTakeoverError(null);
  }, [takeover?.id]);

  useEffect(() => {
    const previousId = previousQueuedEditIdRef.current;
    const nextEdit = queuedEdit;
    const nextId = nextEdit?.commentId ?? null;

    if (nextEdit && previousId !== nextId) {
      if (!queuedEditBackupRef.current) {
        queuedEditBackupRef.current = {
          body: bodyRef.current,
          attachments: attachmentsRef.current,
          pendingMode,
          pendingAssignee: pendingAssigneeRef.current,
        };
        if (draftKey) saveDraft(draftKey, bodyRef.current);
      }
      if (draftTimer.current) {
        clearTimeout(draftTimer.current);
        draftTimer.current = null;
      }
      bodyRef.current = nextEdit.body;
      setBody(nextEdit.body);
      setAttachments([]);
      requestAnimationFrame(() => editorRef.current?.focus());
    } else if (!nextId && previousId) {
      const backup = queuedEditBackupRef.current;
      if (backup) {
        bodyRef.current = backup.body;
        setBody(backup.body);
        setAttachments(backup.attachments);
        setPendingMode(backup.pendingMode);
        setPendingAssignee(backup.pendingAssignee);
        if (draftKey) saveDraft(draftKey, backup.body);
      }
      queuedEditBackupRef.current = null;
      requestAnimationFrame(() => editorRef.current?.focus());
    }

    previousQueuedEditIdRef.current = nextId;
  }, [draftKey, pendingMode, queuedEdit]);

  useEffect(() => {
    if (!draftKey || queuedEdit) return;
    setBody(loadDraft(draftKey));
  }, [draftKey, queuedEdit]);

  useEffect(() => {
    if (!draftKey || queuedEdit) {
      if (draftTimer.current) {
        clearTimeout(draftTimer.current);
        draftTimer.current = null;
      }
      return;
    }
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey, queuedEdit]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (draftKey && !queuedEditRef.current)
        saveDraft(draftKey, bodyRef.current);
    };
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    const flushDraft = () => {
      if (!queuedEditRef.current) saveDraft(draftKey, bodyRef.current);
    };
    window.addEventListener("beforeunload", flushDraft);
    return () => window.removeEventListener("beforeunload", flushDraft);
  }, [draftKey]);

  const modeMeta = workModeMetaFor(pendingMode);
  const canAcceptFiles = !queuedEdit && Boolean(onAttachImage || onImageUpload);
  const showAssignee = Boolean(
    enableReassign && reassignOptions && reassignOptions.length > 0,
  );
  const assigneeValue = pendingAssignee ?? currentAssigneeValue;
  const assigneeLabel =
    reassignOptions?.find((o) => o.id === assigneeValue)?.label ?? "Unassigned";
  const assigneeName =
    assigneeLabel === "Unassigned" ? "the agent" : assigneeLabel;
  const effectivePlaceholder = queuedEdit
    ? "Edit queued message…"
    : (placeholder ?? modePlaceholder(pendingMode, assigneeName));

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
    setAttachments((prev) => [
      ...prev,
      { id, name: file.name, size: file.size, status: "uploading" },
    ]);
    try {
      if (!onAttachImage) {
        setAttachments((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: "error",
                  error: "This file type cannot be attached here",
                }
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
            ? {
                ...item,
                name,
                status: "attached",
                contentPath: attachment?.contentPath,
              }
            : item,
        ),
      );
    } catch (err) {
      setAttachments((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "error",
                error: err instanceof Error ? err.message : "Upload failed",
              }
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
      editorRef.current?.insertMarkdown(
        `![${escapeMarkdownLabel(file.name)}](${url})`,
      );
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
  const takeoverVisible = Boolean(
    takeover && !queuedEdit && !submitting && !uploadPending,
  );
  const previousTakeoverVisibleRef = useRef(takeoverVisible);
  useEffect(() => {
    if (previousTakeoverVisibleRef.current && !takeoverVisible && !queuedEdit) {
      requestAnimationFrame(() => editorRef.current?.focus());
    }
    previousTakeoverVisibleRef.current = takeoverVisible;
  }, [queuedEdit, takeoverVisible]);

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
    // A queued edit must preserve the complete Markdown source. Normal sends
    // keep the longstanding trimmed-body behavior.
    const fullBody = queuedEdit
      ? submittedBody
      : [trimmed, refLines].filter(Boolean).join("\n\n");
    const hasReassignment =
      showAssignee && assigneeValue !== currentAssigneeValue;
    const reassignment = hasReassignment
      ? parseAssigneeValue(assigneeValue)
      : undefined;
    const reopen = shouldImplicitlyReopenComment(issueStatus, assigneeValue)
      ? true
      : undefined;

    // The thread renders the outgoing comment optimistically, so remove its
    // text from the composer at the same time. The editor remains writable for
    // the next draft while the request is pending.
    bodyRef.current = "";
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    if (draftKey) clearDraft(draftKey);
    setBody("");
    setSubmitting(true);
    try {
      if (queuedEdit) {
        if (!onSaveQueuedEdit) return;
        await onSaveQueuedEdit(queuedEdit.commentId, fullBody);
        onCancelQueuedEdit?.();
        return;
      }
      if (pendingMode !== workMode && onWorkModeChange) {
        await onWorkModeChange(pendingMode);
      }
      await onAdd(fullBody, reopen, reassignment);
      if (draftKey && bodyRef.current) {
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
      // Restore the failed message for retry without discarding a next draft
      // that was entered while the request was pending.
      const nextDraft = bodyRef.current;
      const restoredBody = nextDraft
        ? `${submittedBody}\n\n${nextDraft}`
        : submittedBody;
      bodyRef.current = restoredBody;
      if (draftTimer.current) {
        clearTimeout(draftTimer.current);
        draftTimer.current = null;
      }
      if (draftKey) saveDraft(draftKey, restoredBody);
      setBody(restoredBody);
    } finally {
      setSubmitting(false);
    }
  }

  function skipTakeover() {
    if (!takeover) return;
    setTakeoverBusy(true);
    setTakeoverError(null);
    Promise.resolve(takeover.onSkip()).catch((cause) => {
      setTakeoverBusy(false);
      setTakeoverError(
        cause instanceof Error
          ? cause.message
          : "This request could not be skipped.",
      );
    });
  }

  const takeoverSkipButton = takeover ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={takeoverBusy}
      onClick={skipTakeover}
    >
      {takeoverBusy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : null}
      Skip
    </Button>
  ) : null;

  return (
    <div
      className={cn(
        streamlined
          ? "paperclip-task-chat-composer rounded-(--radius-task-composer) border border-border bg-card p-(--sz-18px) shadow-(--shadow-task-composer) dark:border-0 dark:bg-muted dark:shadow-none"
          : "paperclip-task-chat-composer rounded-xl bg-card p-(--sz-18px)",
      )}
      onKeyDownCapture={(e) => {
        // Capture mode shortcuts on the wrapper so they work while the rich
        // editor is focused and win over Lexical/browser bindings. Match the
        // period by key and code because hardware keyboards on iOS can omit
        // `code` for Cmd+Period.
        if (disabled || queuedEdit || takeoverVisible) return;
        const isPeriod = e.key === "." || e.code === "Period";
        const isModeShortcut =
          (isPeriod && (e.metaKey || e.ctrlKey)) ||
          (e.key === "Tab" && e.shiftKey);
        if (isModeShortcut) {
          e.preventDefault();
          e.stopPropagation();
          setPendingMode((mode) => nextWorkMode(mode));
        }
      }}
      onPasteCapture={handlePasteCapture}
    >
      {takeoverVisible && takeover ? (
        <section
          className="relative"
          aria-label={takeover.label}
          data-testid="task-chat-composer-takeover"
        >
          <div
            className="mb-3 flex min-w-0 items-center gap-2"
            data-testid="task-chat-composer-takeover-header"
          >
            <div className="min-w-0 flex-1">
              {!takeoverHeaderClaimed ? (
                <strong className="block truncate text-sm font-medium text-foreground">
                  {takeover.label}
                </strong>
              ) : null}
              <div
                ref={setTakeoverHeaderSlot}
                className="flex min-w-0 items-center"
                data-testid="task-chat-composer-takeover-title-slot"
              />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {takeover.pendingCount > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={takeover.onShowNext}
                >
                  {takeover.pendingCount} pending
                </Button>
              ) : null}
              <div
                ref={setTakeoverControlsSlot}
                className="flex shrink-0 items-center"
                data-testid="task-chat-composer-takeover-controls-slot"
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Dismiss ${takeover.label}`}
                disabled={takeoverBusy}
                onClick={takeover.onDismiss}
              >
                <X aria-hidden />
              </Button>
            </div>
          </div>
          <div className="pr-1" data-testid="task-chat-composer-takeover-body">
            <TaskChatComposerTakeoverActionsContext.Provider
              value={{
                skipButton:
                  takeover.inlineSkip &&
                  !takeover.hideSkip &&
                  takeoverSkipButton
                    ? takeoverSkipButton
                    : null,
                headerSlot: takeoverHeaderSlot,
                controlsSlot: takeoverControlsSlot,
                setHeaderClaimed: setTakeoverHeaderClaimed,
              }}
            >
              {takeover.content}
            </TaskChatComposerTakeoverActionsContext.Provider>
          </div>
          {takeoverError ? (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {takeoverError}
            </p>
          ) : null}
          {!takeover.inlineSkip && !takeover.hideSkip ? (
            <div className="mt-3 flex items-center justify-end gap-2">
              {takeoverSkipButton}
            </div>
          ) : null}
        </section>
      ) : (
        <>
          {pendingTakeover || takeover ? (
            <button
              type="button"
              className="mb-2 flex w-full items-center gap-2 rounded-md bg-muted/50 px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={pendingTakeover?.onOpen}
              data-testid="task-chat-pending-input-indicator"
            >
              <CircleHelp className="h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {pendingTakeover?.label ?? takeover?.label ?? "Pending input"}
              </span>
              <span className="shrink-0 font-medium">
                {pendingTakeover?.count ?? takeover?.pendingCount ?? 1} pending
              </span>
            </button>
          ) : null}
          <div data-testid="task-chat-composer-input">
            <MarkdownEditor
              ref={editorRef}
              value={body}
              onChange={setBody}
              placeholder={
                disabled
                  ? (disabledReason ?? "Composer disabled")
                  : effectivePlaceholder
              }
              readOnly={disabled}
              mentions={mentions}
              onSubmit={() => void submit()}
              imageUploadHandler={
                canAcceptFiles ? uploadInlineImage : undefined
              }
              onDropFile={canAcceptFiles ? attachNonImageFile : undefined}
              bordered={false}
              className={cn(disabled && "opacity-60")}
              contentClassName={
                mobile
                  ? "max-h-(--sz-28dvh) min-h-(--sz-72px) overflow-y-auto px-1 py-1 text-base scrollbar-auto-hide"
                  : "max-h-(--sz-28dvh) min-h-(--sz-48px) overflow-y-auto px-1 py-1 text-sm scrollbar-auto-hide"
              }
            />
          </div>

          {attachments.length > 0 ? (
            <AttachmentGroup
              className="mb-1 px-1"
              data-testid="task-chat-composer-attachments"
            >
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
                      <AttachmentTitle className="max-w-48">
                        {attachment.name}
                      </AttachmentTitle>
                      <AttachmentDescription className="max-w-48">
                        {attachment.status === "uploading"
                          ? "Uploading…"
                          : attachment.status === "error"
                            ? (attachment.error ?? "Upload failed")
                            : [kind.label, sizeLabel]
                                .filter(Boolean)
                                .join(" · ")}
                      </AttachmentDescription>
                    </AttachmentContent>
                    <AttachmentActions>
                      <AttachmentAction
                        aria-label={`Remove ${attachment.name}`}
                        onClick={() =>
                          setAttachments((prev) =>
                            prev.filter((item) => item.id !== attachment.id),
                          )
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

          <div
            className="mt-2 flex items-center gap-2"
            data-testid="task-chat-composer-actions"
          >
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

            {queuedEdit ? (
              <span className="px-1 text-xs font-medium text-muted-foreground">
                {queuedEdit.stale
                  ? "Queued message changed"
                  : "Editing queued message"}
              </span>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={disabled || !onWorkModeChange}
                    aria-keyshortcuts="Meta+Period Control+Period Shift+Tab"
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium disabled:opacity-50",
                      streamlined
                        ? "status-chip border-0 transition hover:brightness-110 focus-visible:brightness-110 focus-visible:outline-none"
                        : "status-chip transition hover:brightness-110 focus-visible:brightness-110 focus-visible:outline-none",
                    )}
                    style={{ "--sc": modeHue(pendingMode) } as CSSProperties}
                    data-testid="task-chat-composer-mode"
                    data-pending-work-mode={pendingMode}
                  >
                    {modeMeta.label}
                    <ChevronDown className="h-3 w-3" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="flex w-(--sz-300px) flex-col gap-0.5"
                  data-testid="task-chat-composer-mode-menu"
                >
                  {workModeMetaList().map((m) => {
                    const Icon = m.icon;
                    const selected = m.value === pendingMode;
                    return (
                      <DropdownMenuItem
                        key={m.value}
                        onSelect={() => setPendingMode(m.value)}
                        style={
                          selected
                            ? {
                                backgroundColor: `color-mix(in srgb, ${modeHue(m.value)} 12%, transparent)`,
                              }
                            : undefined
                        }
                      >
                        <Icon
                          className="h-4 w-4 shrink-0"
                          style={{ color: modeHue(m.value) }}
                          aria-hidden
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="font-medium">{m.label}</span>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {MODE_DESCRIPTION[m.value] ?? ""}
                          </span>
                        </span>
                        {selected ? (
                          <Check className="h-4 w-4 shrink-0" aria-hidden />
                        ) : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <div className="flex-1" />

            {showAssignee && !queuedEdit ? (
              <InlineEntitySelector
                value={assigneeValue}
                options={reassignOptions ?? []}
                placeholder="Assignee"
                noneLabel="No assignee"
                searchPlaceholder="Search assignees…"
                emptyMessage="No matches."
                onChange={setPendingAssignee}
                disabled={disabled}
                triggerTestId="task-chat-composer-assignee"
                className="h-8 gap-1.5 border-0 bg-transparent px-2.5 text-xs shadow-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-0"
                renderTriggerValue={(option) => {
                  return (
                    <>
                      <AssigneeIdentityAvatar
                        assigneeValue={option?.id ?? ""}
                        label={assigneeLabel}
                        agentMap={agentMap}
                        userProfileMap={userProfileMap}
                        placement="trigger"
                      />
                      <span className="max-w-40 truncate">{assigneeLabel}</span>
                      <ChevronDown
                        className="h-3 w-3 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    </>
                  );
                }}
                renderOption={(option) => {
                  return (
                    <>
                      <AssigneeIdentityAvatar
                        assigneeValue={option.id}
                        label={option.label}
                        agentMap={agentMap}
                        userProfileMap={userProfileMap}
                        placement="option"
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            ) : null}

            {queuedEdit ? (
              <button
                type="button"
                onClick={onCancelQueuedEdit}
                disabled={submitting}
                className="h-8 shrink-0 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
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
                queuedEdit
                  ? queuedEdit.stale
                    ? "Queue as new message"
                    : "Save queued message"
                  : uploadPending
                    ? "Waiting for upload to finish"
                    : uploadFailed
                      ? "Remove the failed attachment to send"
                      : "Send (⌘+Enter)"
              }
              aria-label={
                queuedEdit
                  ? queuedEdit.stale
                    ? "Queue as new message"
                    : "Save queued message"
                  : "Send"
              }
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center transition-transform hover:scale-105 disabled:scale-100",
                streamlined
                  ? "rounded-full bg-foreground text-background disabled:bg-foreground disabled:text-background disabled:opacity-100"
                  : "rounded-md bg-primary text-primary-foreground disabled:bg-muted disabled:text-muted-foreground",
              )}
              data-testid="task-chat-composer-send"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ArrowUp className="h-4 w-4" aria-hidden />
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
