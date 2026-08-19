import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  AssistantRuntimeProvider,
  useAui,
  type ThreadMessage,
} from "@assistant-ui/react";
import type {
  Agent,
  IssueAttachment,
  IssueWorkMode,
} from "@paperclipai/shared";
import { buildAgentMentionHref } from "@paperclipai/shared";
import {
  usePaperclipIssueRuntime,
  type PaperclipIssueRuntimeReassignment,
  type PaperclipIssueRuntimeSendOptions,
} from "../hooks/usePaperclipIssueRuntime";
import {
  computeComposerHandoffPreview,
  extractAgentMentionIds,
  findPlainAgentNameCandidate,
  type ComposerHandoffPreview,
  type HandoffAgentMention,
} from "../lib/interrupt-handoff";
import {
  ComposerHandoffPreviewRow,
  ComposerMentionCoach,
  type HandoffChipResolvers,
} from "./interrupt-handoff/InterruptHandoffViews";
import {
  captureComposerViewportSnapshot,
  restoreComposerViewportSnapshot,
} from "../lib/issue-chat-scroll";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { cn } from "../lib/utils";
import { nextWorkMode, titleForPendingWorkMode, workModeMetaFor, workModeMetaList } from "../lib/work-mode-meta";
import { MarkdownEditor, type MentionOption, type MarkdownEditorRef } from "./MarkdownEditor";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { AgentIcon } from "./AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, Check, ChevronDown, Loader2, Paperclip } from "lucide-react";
import type { IssueChatComposerHandle } from "./IssueChatThread";

// ---------------------------------------------------------------------------
// Lazily-loaded issue-chat composer.
//
// The composer is the only part of the issue thread that needs the heavy
// @assistant-ui/react runtime (via `useAui`/`usePaperclipIssueRuntime`) and the
// mdxeditor-backed MarkdownEditor. Extracting it into this module — dynamically
// imported by IssueChatThread — keeps assistant-ui off the issue page's
// critical path: the read-only transcript renders immediately from props and
// the composer (plus its runtime) hydrates once this chunk loads.
// ---------------------------------------------------------------------------

const DRAFT_DEBOUNCE_MS = 800;
const COMPOSER_FOCUS_SCROLL_PADDING_PX = 96;

type ComposerAttachmentItem = {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "attached" | "error";
  inline: boolean;
  contentPath?: string;
  error?: string;
};

function hasFilePayload(evt: ReactDragEvent<HTMLDivElement>) {
  return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
}

function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey, value);
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

function parseReassignment(target: string): PaperclipIssueRuntimeReassignment | null {
  if (!target || target === "__none__") {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (target.startsWith("agent:")) {
    const assigneeAgentId = target.slice("agent:".length);
    return assigneeAgentId ? { assigneeAgentId, assigneeUserId: null } : null;
  }
  if (target.startsWith("user:")) {
    const assigneeUserId = target.slice("user:".length);
    return assigneeUserId ? { assigneeAgentId: null, assigneeUserId } : null;
  }
  return null;
}

function shouldImplicitlyReopenComment(issueStatus: string | undefined, assigneeValue: string) {
  const resumesToTodo = issueStatus === "done" || issueStatus === "cancelled" || issueStatus === "blocked";
  return resumesToTodo && assigneeValue.startsWith("agent:");
}

function isUnassignedReassignValue(value: string): boolean {
  return !value || value === "__none__";
}

export function shouldRenderComposerHandoffPreview(body: string, preview: ComposerHandoffPreview): boolean {
  return Boolean(body.trim()) && preview.kind !== "none";
}

interface IssueChatComposerProps {
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  agentMap?: Map<string, Agent>;
  /** Whether an agent run is currently in flight, so the composer can preview an interrupt. */
  hasActiveRun?: boolean;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  composerDisabledReason?: string | null;
  composerHint?: string | null;
  issueStatus?: string;
  issueWorkMode?: IssueWorkMode;
  onWorkModeChange?: (workMode: IssueWorkMode) => Promise<void> | void;
}

const IssueChatComposer = forwardRef<IssueChatComposerHandle, IssueChatComposerProps>(function IssueChatComposer({
  onImageUpload,
  onAttachImage,
  draftKey,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions = [],
  agentMap,
  hasActiveRun = false,
  currentUserId = null,
  userLabelMap = null,
  composerDisabledReason = null,
  composerHint = null,
  issueStatus,
  issueWorkMode,
  onWorkModeChange,
}, forwardedRef) {
  const api = useAui();
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachmentItem[]>([]);
  const dragDepthRef = useRef(0);
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(effectiveSuggestedAssigneeValue);
  const [noAssigneeDialogOpen, setNoAssigneeDialogOpen] = useState(false);
  const [dismissedCoachToken, setDismissedCoachToken] = useState<string | null>(null);
  const resolvedIssueWorkMode: IssueWorkMode = issueWorkMode ?? "standard";
  const [pendingWorkMode, setPendingWorkMode] = useState<IssueWorkMode>(resolvedIssueWorkMode);
  const [workModeMenuOpen, setWorkModeMenuOpen] = useState(false);
  const canToggleWorkMode = typeof onWorkModeChange === "function";
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const reassignTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusAssigneeOnDialogCloseRef = useRef(false);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canAcceptFiles = Boolean(onImageUpload || onAttachImage);

  function queueViewportRestore(snapshot: ReturnType<typeof captureComposerViewportSnapshot>) {
    if (!snapshot) return;
    requestAnimationFrame(() => {
      restoreComposerViewportSnapshot(snapshot, composerContainerRef.current);
    });
  }

  function focusComposer() {
    if (typeof composerContainerRef.current?.scrollIntoView === "function") {
      composerContainerRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    requestAnimationFrame(() => {
      window.scrollBy({ top: COMPOSER_FOCUS_SCROLL_PADDING_PX, behavior: "smooth" });
      editorRef.current?.focus();
    });
  }

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
    };
  }, []);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  useEffect(() => {
    setPendingWorkMode(resolvedIssueWorkMode);
  }, [resolvedIssueWorkMode]);

  useImperativeHandle(forwardedRef, () => ({
    focus: focusComposer,
    restoreDraft: (submittedBody: string) => {
      setBody((current) =>
        restoreSubmittedCommentDraft({
          currentBody: current,
          submittedBody,
        }),
      );
      focusComposer();
    },
  }), []);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;

    const composerHasAssigneePicker = enableReassign && reassignOptions.length > 0;
    if (composerHasAssigneePicker && isUnassignedReassignValue(reassignTarget)) {
      setNoAssigneeDialogOpen(true);
      return;
    }

    await submitComment();
  }

  async function submitComment() {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;

    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : undefined;
    const reopen = shouldImplicitlyReopenComment(
      issueStatus,
      hasReassignment ? reassignTarget : currentAssigneeValue,
    ) ? true : undefined;
    const submittedBody = trimmed;
    const viewportSnapshot = captureComposerViewportSnapshot(composerContainerRef.current);

    const workModeChanged = pendingWorkMode !== resolvedIssueWorkMode;
    setSubmitting(true);
    setBody("");
    try {
      if (workModeChanged && onWorkModeChange) {
        await onWorkModeChange(pendingWorkMode);
      }
      const appendPromise = api.thread().append({
        role: "user",
        content: [{ type: "text", text: submittedBody }],
        metadata: { custom: {} },
        attachments: [],
        runConfig: {
          custom: {
            ...(reopen ? { reopen: true } : {}),
            ...(reassignment ? { reassignment } : {}),
          },
        },
      });
      queueViewportRestore(viewportSnapshot);
      await appendPromise;
      if (draftKey) clearDraft(draftKey);
      setComposerAttachments([]);
      setReassignTarget(effectiveSuggestedAssigneeValue);
    } catch {
      setBody((current) =>
        restoreSubmittedCommentDraft({
          currentBody: current,
          submittedBody,
        }),
      );
    } finally {
      setSubmitting(false);
      queueViewportRestore(viewportSnapshot);
    }
  }

  async function attachFile(file: File) {
    const attachmentId = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    const inline = Boolean(onImageUpload && file.type.startsWith("image/"));
    setComposerAttachments((prev) => [
      ...prev,
      {
        id: attachmentId,
        name: file.name,
        size: file.size,
        status: "uploading",
        inline,
      },
    ]);

    try {
      if (onImageUpload && file.type.startsWith("image/")) {
        const url = await onImageUpload(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => prev ? `${prev}\n\n${markdown}` : markdown);
        setComposerAttachments((prev) => prev.map((item) =>
          item.id === attachmentId
            ? { ...item, status: "attached", contentPath: url }
            : item,
        ));
      } else if (onAttachImage) {
        const attachment = await onAttachImage(file);
        setComposerAttachments((prev) => prev.map((item) =>
          item.id === attachmentId
            ? {
                ...item,
                status: "attached",
                contentPath: attachment?.contentPath,
                name: attachment?.originalFilename ?? item.name,
              }
            : item,
        ));
      } else {
        setComposerAttachments((prev) => prev.map((item) =>
          item.id === attachmentId
            ? { ...item, status: "error", error: "This file type cannot be attached here" }
            : item,
        ));
      }
    } catch (err) {
      setComposerAttachments((prev) => prev.map((item) =>
        item.id === attachmentId
          ? {
              ...item,
              status: "error",
              error: err instanceof Error ? err.message : "Upload failed",
            }
          : item,
      ));
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      await attachFile(file);
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  async function handleDroppedFiles(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    setAttaching(true);
    try {
      for (const file of Array.from(files)) {
        await attachFile(file);
      }
    } finally {
      setAttaching(false);
    }
  }

  function resetDragState() {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }

  function handleFileDragEnter(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleFileDragOver(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.dataTransfer.dropEffect = "copy";
  }

  function handleFileDragLeave(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function handleFileDrop(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    resetDragState();
    void handleDroppedFiles(evt.dataTransfer?.files);
  }

  const canSubmit = !submitting && !!body.trim();

  // Interrupt-handoff clarity (PAP-10669): preview what this comment will durably
  // do, and coach plain agent names toward real mentions.
  const agentMentionOptions = useMemo<HandoffAgentMention[]>(
    () =>
      mentions
        .filter((m) => (m.kind ?? "agent") === "agent" && (m.agentId ?? m.id))
        .map((m) => ({ agentId: m.agentId ?? m.id.replace(/^agent:/, ""), name: m.name })),
    [mentions],
  );
  const handoffResolvers = useMemo<HandoffChipResolvers>(
    () => ({
      agentMap,
      currentUserId,
      resolveUserLabel: (userId: string) => formatAssigneeUserLabel(userId, null, userLabelMap),
    }),
    [agentMap, currentUserId, userLabelMap],
  );
  const mentionedAgentIds = useMemo(() => extractAgentMentionIds(body), [body]);
  const plainNameCandidate = useMemo(
    () => (mentionedAgentIds.length > 0 ? null : findPlainAgentNameCandidate(body, agentMentionOptions)),
    [body, mentionedAgentIds, agentMentionOptions],
  );
  const handoffPreview = useMemo(
    () =>
      computeComposerHandoffPreview({
        reassignTarget,
        currentAssigneeValue,
        hasActiveRun,
        bodyHasAgentMention: mentionedAgentIds.length > 0,
        mentionedAgentId: mentionedAgentIds[0] ?? null,
        plainNameCandidate,
      }),
    [reassignTarget, currentAssigneeValue, hasActiveRun, mentionedAgentIds, plainNameCandidate],
  );
  const coachVisible = Boolean(
    plainNameCandidate && plainNameCandidate.matchedText !== dismissedCoachToken,
  );
  const coachAgentName = plainNameCandidate
    ? agentMap?.get(plainNameCandidate.agentId)?.name ?? plainNameCandidate.matchedText
    : "";

  function insertCoachMention() {
    if (!plainNameCandidate) return;
    const option = mentions.find(
      (m) => (m.agentId ?? m.id.replace(/^agent:/, "")) === plainNameCandidate.agentId,
    );
    const agentId = plainNameCandidate.agentId;
    const name = option?.name ?? plainNameCandidate.matchedText;
    const markdown = `[@${name}](${buildAgentMentionHref(agentId, option?.agentIcon ?? null)}) `;
    // Replace the first bare occurrence of the matched token (outside links).
    const tokenRe = new RegExp(
      `(?<![\\w@/])${plainNameCandidate.matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`,
      "i",
    );
    setBody((current) => {
      if (tokenRe.test(current)) return current.replace(tokenRe, markdown.trimEnd());
      return current ? `${current} ${markdown}` : markdown;
    });
    setDismissedCoachToken(plainNameCandidate.matchedText);
  }

  if (composerDisabledReason) {
    return (
      <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
        {composerDisabledReason}
      </div>
    );
  }

  const workModeOptions = workModeMetaList();
  const pendingWorkModeMeta = workModeMetaFor(pendingWorkMode);
  const PendingWorkModeIcon = pendingWorkModeMeta.icon;

  function handleComposerKeyDown(evt: ReactKeyboardEvent<HTMLDivElement>) {
    // Match the period via both `code` and `key`: iOS Safari with a hardware
    // keyboard often leaves `code` empty for cmd-period, so relying on it alone
    // lets the event fall through and triggers Safari's default cancel/dismiss
    // (which closes the view). Catching `key === "."` keeps the shortcut working
    // on iOS while preserving desktop behavior.
    const isPeriod = evt.code === "Period" || evt.key === ".";
    if (!(evt.metaKey || evt.ctrlKey) || !isPeriod) return;
    evt.preventDefault();
    setPendingWorkMode((current) => nextWorkMode(current));
  }

  return (
    <div
      ref={composerContainerRef}
      data-testid="issue-chat-composer"
      data-pending-work-mode={pendingWorkMode}
      className={cn(
        "relative rounded-md border border-border/70 bg-background/95 p-(--sz-15px) shadow-(--shadow-extract-4) backdrop-blur transition-(--tp-border-color-background-color-box-shadow) duration-150 supports-[backdrop-filter]:bg-background/85 dark:shadow-(--shadow-extract-5)",
        pendingWorkModeMeta.classes.container,
        isDragOver && "border-primary/45 bg-background shadow-(--shadow-extract-7)",
      )}
      onKeyDownCapture={handleComposerKeyDown}
      onDragEnterCapture={handleFileDragEnter}
      onDragOverCapture={handleFileDragOver}
      onDragLeaveCapture={handleFileDragLeave}
      onDropCapture={handleFileDrop}
    >
      {isDragOver && canAcceptFiles ? (
        <div
          data-testid="issue-chat-composer-drop-overlay"
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-sm border border-dashed border-primary/55 bg-background/75 px-4 py-3 text-center shadow-sm backdrop-blur-(--blur-2px) dark:bg-background/65"
        >
          <div className="flex max-w-md items-center gap-3 rounded-md bg-background/80 px-3 py-2 text-left shadow-sm ring-1 ring-border/60">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Paperclip className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">Drop to upload</div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Images insert into the reply. Other files are added to this task.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <MarkdownEditor
        ref={editorRef}
        value={body}
        onChange={setBody}
        placeholder="Reply"
        mentions={mentions}
        onSubmit={handleSubmit}
        imageUploadHandler={onImageUpload}
        fileDropTarget="parent"
        bordered={false}
        contentClassName="max-h-(--sz-28dvh) overflow-y-auto pr-1 pb-2 text-sm scrollbar-auto-hide"
      />

      {coachVisible && plainNameCandidate ? (
        <div className="mt-2">
          <ComposerMentionCoach
            candidate={plainNameCandidate}
            agentDisplayName={coachAgentName}
            onInsert={insertCoachMention}
            onDismiss={() => setDismissedCoachToken(plainNameCandidate.matchedText)}
          />
        </div>
      ) : null}

      {composerHint ? (
        <div className="inline-flex items-center rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-(length:--text-micro) text-muted-foreground">
          {composerHint}
        </div>
      ) : null}

      {composerAttachments.length > 0 ? (
        <div
          data-testid="issue-chat-composer-attachments"
          className="mb-3 mt-2 space-y-1.5 rounded-md border border-dashed border-border/80 bg-muted/20 p-2"
        >
          {composerAttachments.map((attachment) => {
            const sizeLabel = formatAttachmentSize(attachment.size);
            const statusLabel =
              attachment.status === "uploading"
                ? "Uploading to task"
                : attachment.status === "error"
                  ? attachment.error ?? "Upload failed"
                  : attachment.inline
                    ? "Inserted inline"
                    : "Attached to task";
            return (
              <div
                key={attachment.id}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
                  attachment.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-background/70 text-muted-foreground",
                )}
              >
                {attachment.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : attachment.status === "attached" ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {attachment.name}
                </span>
                {sizeLabel ? (
                  <span className="shrink-0 text-muted-foreground">{sizeLabel}</span>
                ) : null}
                <span className="shrink-0 text-muted-foreground">{statusLabel}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {shouldRenderComposerHandoffPreview(body, handoffPreview) ? (
        <div className="my-2">
          <ComposerHandoffPreviewRow preview={handoffPreview} resolvers={handoffResolvers} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="mr-auto flex items-center gap-2">
          {(onImageUpload || onAttachImage) ? (
            <>
              <input
                ref={attachInputRef}
                type="file"
                className="hidden"
                onChange={handleAttachFile}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={attaching}
                title="Attach file"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {canToggleWorkMode ? (
            <Popover open={workModeMenuOpen} onOpenChange={setWorkModeMenuOpen}>
              <PopoverTrigger asChild>
                {/* Single persistent mode chip (PAP-95b mockup rev 5): yellow in
                    planning, neutral in standard, caret opens the switch menu. */}
                <button
                  type="button"
                  data-testid="issue-chat-composer-work-mode-toggle"
                  data-pending-work-mode={pendingWorkMode}
                  aria-haspopup="menu"
                  aria-expanded={workModeMenuOpen}
                  aria-pressed={pendingWorkMode !== "standard"}
                  aria-keyshortcuts="Meta+Period Control+Period"
                  title={titleForPendingWorkMode(pendingWorkMode)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-(length:--text-micro) font-semibold transition-colors",
                    pendingWorkModeMeta.classes.chip,
                  )}
                >
                  <PendingWorkModeIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{pendingWorkModeMeta.label}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-44 p-1"
                align="start"
                data-testid="issue-chat-composer-work-mode-menu"
              >
                {workModeOptions.map((option) => {
                  const Icon = option.icon;
                  const active = option.value === pendingWorkMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={`issue-chat-composer-work-mode-menu-${option.value}`}
                      data-pending-work-mode={pendingWorkMode}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                        active && "bg-accent",
                        option.classes.menuItem,
                      )}
                      onClick={() => {
                        setPendingWorkMode(option.value);
                        setWorkModeMenuOpen(false);
                      }}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>{option.label}</span>
                      {active ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
                    </button>
                  );
                })}
                <div className="mt-1 border-t px-2 py-1.5 text-(length:--text-nano) text-muted-foreground">
                  Cmd/Ctrl+. cycles modes
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>

        {enableReassign && reassignOptions.length > 0 ? (
          <InlineEntitySelector
            ref={reassignTriggerRef}
            value={reassignTarget}
            options={reassignOptions}
            placeholder="Responsible"
            noneLabel="No responsible"
            searchPlaceholder="Search responsible..."
            emptyMessage="No responsible found."
            onChange={setReassignTarget}
            className="h-8 text-xs"
            renderTriggerValue={(option) => {
              if (!option) return <span className="text-muted-foreground">Responsible</span>;
              const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        ) : null}

        <Button size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
          {submitting ? "Posting..." : "Send"}
        </Button>
      </div>

      {/* No-assignee warning modal (PAP-128 C): replaces the old press-Send-again toast. */}
      <AlertDialog open={noAssigneeDialogOpen} onOpenChange={setNoAssigneeDialogOpen}>
        <AlertDialogContent
          data-testid="issue-chat-no-assignee-dialog"
          onCloseAutoFocus={(event) => {
            if (!focusAssigneeOnDialogCloseRef.current) return;
            event.preventDefault();
            focusAssigneeOnDialogCloseRef.current = false;
            reassignTriggerRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>No responsible selected</AlertDialogTitle>
            <AlertDialogDescription>
              This comment will be posted without an assignee, so no agent will be woken
              to act on it. Go back to pick a responsible, or send anyway.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="issue-chat-no-assignee-go-back"
              onClick={() => {
                focusAssigneeOnDialogCloseRef.current = true;
              }}
            >
              Go back
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="issue-chat-no-assignee-send-anyway"
              onClick={() => {
                void submitComment();
              }}
            >
              Send anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

interface IssueChatComposerDockProps extends IssueChatComposerProps {
  messages: readonly ThreadMessage[];
  isRunning: boolean;
  onSend: (options: PaperclipIssueRuntimeSendOptions) => Promise<void>;
  onCancel?: (() => Promise<void>) | undefined;
}

// Default export so IssueChatThread can `React.lazy(() => import(...))` this
// module. Owns the assistant-ui runtime so it (and the mdxeditor editor) only
// load once this chunk is fetched.
const IssueChatComposerDock = forwardRef<IssueChatComposerHandle, IssueChatComposerDockProps>(
  function IssueChatComposerDock({ messages, isRunning, onSend, onCancel, ...composerProps }, ref) {
    const runtime = usePaperclipIssueRuntime({ messages, isRunning, onSend, onCancel });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <IssueChatComposer ref={ref} {...composerProps} />
      </AssistantRuntimeProvider>
    );
  },
);

export default IssueChatComposerDock;
