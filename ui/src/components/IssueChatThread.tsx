import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useMessage,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation } from "@/lib/router";
import type {
  Agent,
  FeedbackDataSharingPreference,
  FeedbackVote,
  FeedbackVoteValue,
} from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { usePaperclipIssueRuntime, type PaperclipIssueRuntimeReassignment } from "../hooks/usePaperclipIssueRuntime";
import {
  buildIssueChatMessages,
  type IssueChatComment,
  type IssueChatLinkedRun,
} from "../lib/issue-chat-messages";
import type { IssueTimelineEvent } from "../lib/issue-timeline-events";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MentionOption, type MarkdownEditorRef } from "./MarkdownEditor";
import { Identity } from "./Identity";
import { OutputFeedbackButtons } from "./OutputFeedbackButtons";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { AgentIcon } from "./AgentIconPicker";
import { StatusBadge } from "./StatusBadge";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import { cn, formatDateTime } from "../lib/utils";
import { Check, Copy, Loader2, Paperclip, Square } from "lucide-react";

interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

interface IssueChatThreadProps {
  comments: IssueChatComment[];
  feedbackVotes?: FeedbackVote[];
  feedbackDataSharingPreference?: FeedbackDataSharingPreference;
  feedbackTermsUrl?: string | null;
  linkedRuns?: IssueChatLinkedRun[];
  timelineEvents?: IssueTimelineEvent[];
  liveRuns?: LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  companyId?: string | null;
  projectId?: string | null;
  issueStatus?: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  onCancelRun?: () => Promise<void>;
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  composerDisabledReason?: string | null;
}

const DRAFT_DEBOUNCE_MS = 800;

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
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

function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground transition-colors"
      title="Copy as markdown"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function IssueChatTextPart({ text }: { text: string }) {
  return <MarkdownBody className="text-sm leading-6">{text}</MarkdownBody>;
}

function IssueChatReasoningPart({ text }: { text: string }) {
  return (
    <details className="rounded-lg border border-border/70 bg-background/70 px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Thinking
      </summary>
      <div className="mt-2">
        <MarkdownBody className="text-sm leading-6">{text}</MarkdownBody>
      </div>
    </details>
  );
}

function IssueChatToolPart({
  toolName,
  argsText,
  result,
  isError,
}: {
  toolName: string;
  argsText: string;
  result?: unknown;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const resultText =
    typeof result === "string"
      ? result
      : result === undefined
        ? ""
        : JSON.stringify(result, null, 2);

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2",
        isError
          ? "border-red-300/70 bg-red-50/70 dark:border-red-500/40 dark:bg-red-500/10"
          : "border-border/70 bg-background/70",
      )}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Tool
        </span>
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{toolName}</span>
          {result === undefined ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-200">
              <Loader2 className="h-3 w-3 animate-spin" />
              Running
            </span>
          ) : isError ? (
            <span className="inline-flex items-center rounded-full border border-red-400/50 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-red-700 dark:text-red-200">
              Error
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-emerald-400/50 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-200">
              Complete
            </span>
          )}
        </span>
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          {argsText ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Input
              </div>
              <pre className="overflow-x-auto rounded-md bg-accent/40 p-2 text-xs text-foreground">{argsText}</pre>
            </div>
          ) : null}
          {result !== undefined ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Result
              </div>
              <pre className="overflow-x-auto rounded-md bg-accent/40 p-2 text-xs text-foreground">{resultText}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function IssueChatUserMessage({
  companyId,
  projectId,
}: {
  companyId?: string | null;
  projectId?: string | null;
}) {
  const message = useMessage();
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId = typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const authorName = typeof custom.authorName === "string" ? custom.authorName : "You";
  const body = message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const queued = custom.queueState === "queued" || custom.clientStatus === "queued";
  const pending = custom.clientStatus === "pending";

  return (
    <MessagePrimitive.Root
      id={anchorId}
      className="flex justify-end"
    >
      <div
        className={cn(
          "max-w-[min(680px,92%)] rounded-2xl border px-4 py-3 shadow-sm",
          queued
            ? "border-amber-300/70 bg-amber-50/80 dark:border-amber-500/40 dark:bg-amber-500/10"
            : "border-primary/20 bg-primary/8",
          pending && "opacity-80",
        )}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Identity name={authorName} size="sm" />
            {queued ? (
              <span className="inline-flex items-center rounded-full border border-amber-400/60 bg-amber-100/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200">
                Queued
              </span>
            ) : null}
            {pending ? <span className="text-xs text-muted-foreground">Sending...</span> : null}
          </div>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <a href={anchorId ? `#${anchorId}` : undefined} className="hover:text-foreground hover:underline">
              {formatDateTime(message.createdAt)}
            </a>
            <CopyMarkdownButton text={body} />
          </span>
        </div>

        <div className="space-y-3">
          <MessagePrimitive.Content
            components={{
              Text: ({ text }) => <IssueChatTextPart text={text} />,
            }}
          />
        </div>

        {companyId && typeof custom.commentId === "string" ? null : null}
        {projectId ? null : null}
      </div>
    </MessagePrimitive.Root>
  );
}

function IssueChatAssistantMessage({
  feedbackVoteByTargetId,
  feedbackDataSharingPreference,
  feedbackTermsUrl,
  onVote,
}: {
  feedbackVoteByTargetId: Map<string, FeedbackVoteValue>;
  feedbackDataSharingPreference?: FeedbackDataSharingPreference;
  feedbackTermsUrl?: string | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
}) {
  const message = useMessage();
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId = typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const authorName = typeof custom.authorName === "string"
    ? custom.authorName
    : typeof custom.runAgentName === "string"
      ? custom.runAgentName
      : "Agent";
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId = typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const commentId = typeof custom.commentId === "string" ? custom.commentId : null;
  const notices = Array.isArray(custom.notices)
    ? custom.notices.filter((notice): notice is string => typeof notice === "string" && notice.length > 0)
    : [];
  const waitingText = typeof custom.waitingText === "string" ? custom.waitingText : "";
  const isRunning = message.role === "assistant" && message.status?.type === "running";

  const handleVote = async (
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => {
    if (!commentId || !onVote) return;
    await onVote(commentId, vote, options);
  };

  return (
    <MessagePrimitive.Root id={anchorId} className="flex justify-start">
      <div className="max-w-[min(760px,96%)] rounded-2xl border border-border bg-card px-4 py-3 shadow-sm">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Identity name={authorName} size="sm" />
            {isRunning ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-200">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running
              </span>
            ) : null}
          </div>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <a href={anchorId ? `#${anchorId}` : undefined} className="hover:text-foreground hover:underline">
              {formatDateTime(message.createdAt)}
            </a>
          </span>
        </div>

        <div className="space-y-3">
          <MessagePrimitive.Content
            components={{
              Text: ({ text }) => <IssueChatTextPart text={text} />,
              Reasoning: ({ text }) => <IssueChatReasoningPart text={text} />,
              tools: {
                Override: ({ toolName, argsText, result, isError }) => (
                  <IssueChatToolPart
                    toolName={toolName}
                    argsText={argsText}
                    result={result}
                    isError={isError}
                  />
                ),
              },
            }}
          />
          {message.content.length === 0 && waitingText ? (
            <div className="rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
              {waitingText}
            </div>
          ) : null}
          {notices.length > 0 ? (
            <div className="space-y-2">
              {notices.map((notice, index) => (
                <div
                  key={`${message.id}:notice:${index}`}
                  className="rounded-lg border border-border/60 bg-accent/30 px-3 py-2 text-sm text-muted-foreground"
                >
                  {notice}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          {runId ? (
            runAgentId ? (
              <Link
                to={`/agents/${runAgentId}/runs/${runId}`}
                className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              >
                run {runId.slice(0, 8)}
              </Link>
            ) : (
              <span className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
                run {runId.slice(0, 8)}
              </span>
            )
          ) : null}
          {commentId && onVote ? (
            <OutputFeedbackButtons
              activeVote={feedbackVoteByTargetId.get(commentId) ?? null}
              sharingPreference={feedbackDataSharingPreference ?? "prompt"}
              termsUrl={feedbackTermsUrl ?? null}
              onVote={handleVote}
            />
          ) : null}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function IssueChatSystemMessage() {
  const message = useMessage();
  const custom = message.metadata.custom as Record<string, unknown>;
  const text = message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const anchorId = typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId = typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runStatus = typeof custom.runStatus === "string" ? custom.runStatus : null;

  return (
    <MessagePrimitive.Root id={anchorId} className="flex justify-center">
      <div className="max-w-[min(760px,96%)] rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="whitespace-pre-wrap text-center">{text}</span>
          {runStatus ? <StatusBadge status={runStatus} /> : null}
          {runId && runAgentId ? (
            <Link
              to={`/agents/${runAgentId}/runs/${runId}`}
              className="inline-flex items-center rounded-md border border-border bg-background/70 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground"
            >
              {runId.slice(0, 8)}
            </Link>
          ) : null}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function IssueChatComposer({
  onImageUpload,
  onAttachImage,
  draftKey,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions = [],
  agentMap,
  composerDisabledReason = null,
  issueStatus,
  onCancelRun,
}: {
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  agentMap?: Map<string, Agent>;
  composerDisabledReason?: string | null;
  issueStatus?: string;
  onCancelRun?: (() => Promise<void>) | undefined;
}) {
  const api = useAui();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const [body, setBody] = useState("");
  const [reopen, setReopen] = useState(issueStatus === "done" || issueStatus === "cancelled");
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(effectiveSuggestedAssigneeValue);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<MarkdownEditorRef>(null);
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
    };
  }, []);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;

    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : undefined;
    const submittedBody = trimmed;

    setSubmitting(true);
    setBody("");
    try {
      await api.thread().append({
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
      if (draftKey) clearDraft(draftKey);
      setReopen(issueStatus === "done" || issueStatus === "cancelled");
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
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      if (onImageUpload) {
        const url = await onImageUpload(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => prev ? `${prev}\n\n${markdown}` : markdown);
      } else if (onAttachImage) {
        await onAttachImage(file);
      }
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  async function handleCancelRun() {
    if (!onCancelRun || cancelling) return;
    setCancelling(true);
    try {
      await onCancelRun();
    } finally {
      setCancelling(false);
    }
  }

  const canSubmit = !submitting && !!body.trim();

  if (composerDisabledReason) {
    return (
      <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
        {composerDisabledReason}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-4 shadow-sm">
      {isRunning ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-900 dark:text-cyan-100">
          <span>Messages sent now queue behind the active run.</span>
          {onCancelRun ? (
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
              disabled={cancelling}
              onClick={() => void handleCancelRun()}
            >
              <Square className="mr-1 h-3.5 w-3.5" fill="currentColor" />
              {cancelling ? "Stopping..." : "Interrupt"}
            </Button>
          ) : null}
        </div>
      ) : null}

      <MarkdownEditor
        ref={editorRef}
        value={body}
        onChange={setBody}
        placeholder="Reply in chat..."
        mentions={mentions}
        onSubmit={handleSubmit}
        imageUploadHandler={onImageUpload}
        contentClassName="min-h-[72px] text-sm"
      />

      <div className="mt-3 flex items-center justify-end gap-3">
        {(onImageUpload || onAttachImage) ? (
          <div className="mr-auto flex items-center gap-3">
            <input
              ref={attachInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleAttachFile}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => attachInputRef.current?.click()}
              disabled={attaching}
              title="Attach image"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>
        ) : null}

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={reopen}
            onChange={(event) => setReopen(event.target.checked)}
            className="rounded border-border"
          />
          Re-open
        </label>

        {enableReassign && reassignOptions.length > 0 ? (
          <InlineEntitySelector
            value={reassignTarget}
            options={reassignOptions}
            placeholder="Assignee"
            noneLabel="No assignee"
            searchPlaceholder="Search assignees..."
            emptyMessage="No assignees found."
            onChange={setReassignTarget}
            className="h-8 text-xs"
            renderTriggerValue={(option) => {
              if (!option) return <span className="text-muted-foreground">Assignee</span>;
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
    </div>
  );
}

export function IssueChatThread({
  comments,
  feedbackVotes = [],
  feedbackDataSharingPreference = "prompt",
  feedbackTermsUrl = null,
  linkedRuns = [],
  timelineEvents = [],
  liveRuns = [],
  activeRun = null,
  companyId,
  projectId,
  issueStatus,
  agentMap,
  currentUserId,
  onVote,
  onAdd,
  onCancelRun,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions = [],
  composerDisabledReason = null,
}: IssueChatThreadProps) {
  const location = useLocation();
  const hasScrolledRef = useRef(false);
  const displayLiveRuns = useMemo(() => {
    const deduped = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns) {
      deduped.set(run.id, run);
    }
    if (activeRun) {
      deduped.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        invocationSource: activeRun.invocationSource,
        triggerDetail: activeRun.triggerDetail,
        startedAt: toIsoString(activeRun.startedAt),
        finishedAt: toIsoString(activeRun.finishedAt),
        createdAt: toIsoString(activeRun.createdAt) ?? new Date().toISOString(),
        agentId: activeRun.agentId,
        agentName: activeRun.agentName,
        adapterType: activeRun.adapterType,
      });
    }
    return [...deduped.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [activeRun, liveRuns]);
  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({ runs: displayLiveRuns, companyId });

  const messages = useMemo(
    () =>
      buildIssueChatMessages({
        comments,
        timelineEvents,
        linkedRuns,
        liveRuns,
        activeRun,
        transcriptsByRunId: transcriptByRun,
        hasOutputForRun,
        companyId,
        projectId,
        agentMap,
        currentUserId,
      }),
    [
      comments,
      timelineEvents,
      linkedRuns,
      liveRuns,
      activeRun,
      transcriptByRun,
      hasOutputForRun,
      companyId,
      projectId,
      agentMap,
      currentUserId,
    ],
  );

  const isRunning = displayLiveRuns.some((run) => run.status === "queued" || run.status === "running");
  const feedbackVoteByTargetId = useMemo(() => {
    const map = new Map<string, FeedbackVoteValue>();
    for (const feedbackVote of feedbackVotes) {
      if (feedbackVote.targetType !== "issue_comment") continue;
      map.set(feedbackVote.targetId, feedbackVote.vote);
    }
    return map;
  }, [feedbackVotes]);

  const runtime = usePaperclipIssueRuntime({
    messages,
    isRunning,
    onSend: ({ body, reopen, reassignment }) => onAdd(body, reopen, reassignment),
    onCancel: onCancelRun,
  });

  useEffect(() => {
    const hash = location.hash;
    if (!(hash.startsWith("#comment-") || hash.startsWith("#activity-") || hash.startsWith("#run-"))) return;
    if (messages.length === 0 || hasScrolledRef.current) return;
    const targetId = hash.slice(1);
    const element = document.getElementById(targetId);
    if (!element) return;
    hasScrolledRef.current = true;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [location.hash, messages]);

  const components = useMemo(
    () => ({
      UserMessage: () => <IssueChatUserMessage companyId={companyId} projectId={projectId} />,
      AssistantMessage: () => (
        <IssueChatAssistantMessage
          feedbackVoteByTargetId={feedbackVoteByTargetId}
          feedbackDataSharingPreference={feedbackDataSharingPreference}
          feedbackTermsUrl={feedbackTermsUrl}
          onVote={onVote}
        />
      ),
      SystemMessage: () => <IssueChatSystemMessage />,
    }),
    [
      companyId,
      projectId,
      feedbackVoteByTargetId,
      feedbackDataSharingPreference,
      feedbackTermsUrl,
      onVote,
    ],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Chat ({messages.length})</h3>
          <ThreadPrimitive.ScrollToBottom className="text-xs text-muted-foreground hover:text-foreground">
            Jump to latest
          </ThreadPrimitive.ScrollToBottom>
        </div>

        <ThreadPrimitive.Root className="rounded-2xl border border-border bg-background shadow-sm">
          <ThreadPrimitive.Viewport className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">
            <ThreadPrimitive.Empty>
              <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
                This issue conversation is empty. Start with a message below.
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={components} />
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>

        <IssueChatComposer
          onImageUpload={imageUploadHandler}
          onAttachImage={onAttachImage}
          draftKey={draftKey}
          enableReassign={enableReassign}
          reassignOptions={reassignOptions}
          currentAssigneeValue={currentAssigneeValue}
          suggestedAssigneeValue={suggestedAssigneeValue}
          mentions={mentions}
          agentMap={agentMap}
          composerDisabledReason={composerDisabledReason}
          issueStatus={issueStatus}
          onCancelRun={onCancelRun}
        />
      </div>
    </AssistantRuntimeProvider>
  );
}
