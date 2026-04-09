import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import type {
  Agent,
  Approval,
  FeedbackDataSharingPreference,
  FeedbackVote,
  FeedbackVoteValue,
  IssueComment,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { ArrowRight, Check, Copy, Paperclip } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Identity } from "./Identity";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { OutputFeedbackButtons } from "./OutputFeedbackButtons";
import { ApprovalCard } from "./ApprovalCard";
import { AgentIcon } from "./AgentIconPicker";
import { formatAssigneeUserLabel } from "../lib/assignees";
import type { IssueTimelineAssignee, IssueTimelineEvent } from "../lib/issue-timeline-events";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatDateTime } from "../lib/utils";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import { PluginSlotOutlet } from "@/plugins/slots";

interface CommentWithRunMeta extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
  clientId?: string;
  clientStatus?: "pending" | "queued";
  queueState?: "queued";
  queueTargetRunId?: string | null;
}

interface LinkedRunItem {
  runId: string;
  status: string;
  agentId: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt?: Date | string | null;
}

interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

interface CommentThreadProps {
  comments: CommentWithRunMeta[];
  queuedComments?: CommentWithRunMeta[];
  linkedApprovals?: Approval[];
  feedbackVotes?: FeedbackVote[];
  feedbackDataSharingPreference?: FeedbackDataSharingPreference;
  feedbackTermsUrl?: string | null;
  linkedRuns?: LinkedRunItem[];
  timelineEvents?: IssueTimelineEvent[];
  companyId?: string | null;
  projectId?: string | null;
  onApproveApproval?: (approvalId: string) => Promise<void>;
  onRejectApproval?: (approvalId: string) => Promise<void>;
  pendingApprovalAction?: {
    approvalId: string;
    action: "approve" | "reject";
  } | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  issueStatus?: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Callback to attach an image file to the parent issue (not inline in a comment). */
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  liveRunSlot?: React.ReactNode;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  onInterruptQueued?: (runId: string) => Promise<void>;
  interruptingQueuedRunId?: string | null;
  composerDisabledReason?: string | null;
}

const DRAFT_DEBOUNCE_MS = 800;

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

function parseReassignment(target: string): CommentReassignment | null {
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

function humanizeValue(value: string | null): string {
  if (!value) return "None";
  return value.replace(/_/g, " ");
}

function formatTimelineAssigneeLabel(
  assignee: IssueTimelineAssignee,
  agentMap?: Map<string, Agent>,
  currentUserId?: string | null,
) {
  if (assignee.agentId) {
    return agentMap?.get(assignee.agentId)?.name ?? assignee.agentId.slice(0, 8);
  }
  if (assignee.userId) {
    return formatAssigneeUserLabel(assignee.userId, currentUserId) ?? "Board";
  }
  return "Unassigned";
}

function formatTimelineActorName(
  actorType: IssueTimelineEvent["actorType"],
  actorId: string,
  agentMap?: Map<string, Agent>,
  currentUserId?: string | null,
) {
  if (actorType === "agent") {
    return agentMap?.get(actorId)?.name ?? actorId.slice(0, 8);
  }
  if (actorType === "system") {
    return "System";
  }
  return formatAssigneeUserLabel(actorId, currentUserId) ?? "Board";
}

function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatRunStatusLabel(status: string) {
  switch (status) {
    case "timed_out":
      return "timed out";
    default:
      return status.replace(/_/g, " ");
  }
}

function runTimestamp(run: LinkedRunItem) {
  return run.finishedAt ?? run.startedAt ?? run.createdAt;
}

function runStatusClass(status: string) {
  switch (status) {
    case "succeeded":
      return "text-green-700 dark:text-green-300";
    case "failed":
    case "error":
      return "text-red-700 dark:text-red-300";
    case "timed_out":
      return "text-orange-700 dark:text-orange-300";
    case "running":
      return "text-cyan-700 dark:text-cyan-300";
    case "queued":
    case "pending":
      return "text-amber-700 dark:text-amber-300";
    case "cancelled":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
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

function CommentCard({
  comment,
  agentMap,
  companyId,
  projectId,
  feedbackVote = null,
  feedbackDataSharingPreference = "prompt",
  feedbackTermsUrl = null,
  onVote,
  voting = false,
  highlightCommentId,
  queued = false,
}: {
  comment: CommentWithRunMeta;
  agentMap?: Map<string, Agent>;
  companyId?: string | null;
  projectId?: string | null;
  feedbackVote?: FeedbackVoteValue | null;
  feedbackDataSharingPreference?: FeedbackDataSharingPreference;
  feedbackTermsUrl?: string | null;
  onVote?: (
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  voting?: boolean;
  highlightCommentId?: string | null;
  queued?: boolean;
}) {
  const isHighlighted = highlightCommentId === comment.id;
  const isPending = comment.clientStatus === "pending";
  const isQueued = queued || comment.queueState === "queued" || comment.clientStatus === "queued";

  return (
    <div
      key={comment.id}
      id={`comment-${comment.id}`}
      className={`border p-3 overflow-hidden min-w-0 rounded-sm transition-colors duration-1000 ${
        isQueued
          ? "border-amber-300/70 bg-amber-50/70 dark:border-amber-500/40 dark:bg-amber-500/10"
          : isHighlighted
            ? "border-primary/50 bg-primary/5"
            : "border-border"
      } ${isPending ? "opacity-80" : ""}`}
    >
      <div className="flex items-center justify-between mb-1">
        {comment.authorAgentId ? (
          <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
            <Identity
              name={agentMap?.get(comment.authorAgentId)?.name ?? comment.authorAgentId.slice(0, 8)}
              size="sm"
            />
          </Link>
        ) : (
          <Identity name="You" size="sm" />
        )}
        <span className="flex items-center gap-1.5">
          {isQueued ? (
            <span className="inline-flex items-center rounded-full border border-amber-400/60 bg-amber-100/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200">
              Queued
            </span>
          ) : null}
          {companyId && !isPending ? (
            <PluginSlotOutlet
              slotTypes={["commentContextMenuItem"]}
              entityType="comment"
              context={{
                companyId,
                projectId: projectId ?? null,
                entityId: comment.id,
                entityType: "comment",
                parentEntityId: comment.issueId,
              }}
              className="flex flex-wrap items-center gap-1.5"
              itemClassName="inline-flex"
              missingBehavior="placeholder"
            />
          ) : null}
          {isPending ? (
            <span className="text-xs text-muted-foreground">{isQueued ? "Queueing..." : "Sending..."}</span>
          ) : (
            <a
              href={`#comment-${comment.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
            >
              {formatDateTime(comment.createdAt)}
            </a>
          )}
          <CopyMarkdownButton text={comment.body} />
        </span>
      </div>
      <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
      {companyId && !isPending ? (
        <div className="mt-2 space-y-2">
          <PluginSlotOutlet
            slotTypes={["commentAnnotation"]}
            entityType="comment"
            context={{
              companyId,
              projectId: projectId ?? null,
              entityId: comment.id,
              entityType: "comment",
              parentEntityId: comment.issueId,
            }}
            className="space-y-2"
            itemClassName="rounded-md"
            missingBehavior="placeholder"
          />
        </div>
      ) : null}
      {comment.authorAgentId && onVote && !isQueued && !isPending ? (
        <OutputFeedbackButtons
          activeVote={feedbackVote}
          disabled={voting}
          sharingPreference={feedbackDataSharingPreference}
          termsUrl={feedbackTermsUrl}
          onVote={onVote}
          rightSlot={comment.runId && !isPending ? (
            comment.runAgentId ? (
              <Link
                to={`/agents/${comment.runAgentId}/runs/${comment.runId}`}
                className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                run {comment.runId.slice(0, 8)}
              </Link>
            ) : (
              <span className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
                run {comment.runId.slice(0, 8)}
              </span>
            )
          ) : undefined}
        />
      ) : null}
      {comment.runId && !isPending && !(comment.authorAgentId && onVote && !isQueued) ? (
        <div className="mt-3 pt-3 border-t border-border/60">
          {comment.runAgentId ? (
            <Link
              to={`/agents/${comment.runAgentId}/runs/${comment.runId}`}
              className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              run {comment.runId.slice(0, 8)}
            </Link>
          ) : (
            <span className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
              run {comment.runId.slice(0, 8)}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

type TimelineItem =
  | { kind: "comment"; id: string; createdAtMs: number; comment: CommentWithRunMeta }
  | { kind: "approval"; id: string; createdAtMs: number; approval: Approval }
  | { kind: "event"; id: string; createdAtMs: number; event: IssueTimelineEvent }
  | { kind: "run"; id: string; createdAtMs: number; run: LinkedRunItem };

function TimelineEventCard({
  event,
  agentMap,
  currentUserId,
}: {
  event: IssueTimelineEvent;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
}) {
  const actorName = formatTimelineActorName(event.actorType, event.actorId, agentMap, currentUserId);

  return (
    <div id={`activity-${event.id}`} className="flex items-start gap-2.5 py-1.5">
      <Avatar size="sm" className="mt-0.5">
        <AvatarFallback>{initialsForName(actorName)}</AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm">
          <span className="font-medium text-foreground">{actorName}</span>
          <span className="text-muted-foreground">updated this task</span>
          <a
            href={`#activity-${event.id}`}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(event.createdAt)}
          </a>
        </div>

        {event.statusChange ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-14 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Status
            </span>
            <span className="text-muted-foreground">
              {humanizeValue(event.statusChange.from)}
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-foreground">
              {humanizeValue(event.statusChange.to)}
            </span>
          </div>
        ) : null}

        {event.assigneeChange ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-14 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Assignee
            </span>
            <span className="text-muted-foreground">
              {formatTimelineAssigneeLabel(event.assigneeChange.from, agentMap, currentUserId)}
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-foreground">
              {formatTimelineAssigneeLabel(event.assigneeChange.to, agentMap, currentUserId)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const TimelineList = memo(function TimelineList({
  timeline,
  agentMap,
  currentUserId,
  companyId,
  projectId,
  onApproveApproval,
  onRejectApproval,
  pendingApprovalAction,
  feedbackVoteByTargetId,
  feedbackDataSharingPreference = "prompt",
  feedbackTermsUrl = null,
  onVote,
  votingTargetId,
  highlightCommentId,
}: {
  timeline: TimelineItem[];
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  onApproveApproval?: (approvalId: string) => Promise<void>;
  onRejectApproval?: (approvalId: string) => Promise<void>;
  pendingApprovalAction?: {
    approvalId: string;
    action: "approve" | "reject";
  } | null;
  feedbackVoteByTargetId?: Map<string, FeedbackVoteValue>;
  feedbackDataSharingPreference?: FeedbackDataSharingPreference;
  feedbackTermsUrl?: string | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  votingTargetId?: string | null;
  highlightCommentId?: string | null;
}) {
  if (timeline.length === 0) {
    return <p className="text-sm text-muted-foreground">No timeline entries yet.</p>;
  }

  return (
    <div className="space-y-3">
      {timeline.map((item) => {
        if (item.kind === "event") {
          return (
            <TimelineEventCard
              key={`event:${item.event.id}`}
              event={item.event}
              agentMap={agentMap}
              currentUserId={currentUserId}
            />
          );
        }

        if (item.kind === "approval") {
          const approval = item.approval;
          const isPending = pendingApprovalAction?.approvalId === approval.id;
          return (
            <div id={`approval-${approval.id}`} key={`approval:${approval.id}`} className="py-1.5">
              <ApprovalCard
                approval={approval}
                requesterAgent={approval.requestedByAgentId ? agentMap?.get(approval.requestedByAgentId) ?? null : null}
                onApprove={onApproveApproval ? () => void onApproveApproval(approval.id) : undefined}
                onReject={onRejectApproval ? () => void onRejectApproval(approval.id) : undefined}
                detailLink={`/approvals/${approval.id}`}
                isPending={isPending}
                pendingAction={isPending ? pendingApprovalAction?.action ?? null : null}
              />
            </div>
          );
        }

        if (item.kind === "run") {
          const run = item.run;
          const actorName = agentMap?.get(run.agentId)?.name ?? run.agentId.slice(0, 8);
          return (
            <div id={`run-${run.runId}`} key={`run:${run.runId}`} className="flex items-center gap-2.5 py-1.5">
              <Avatar size="sm">
                <AvatarFallback>{initialsForName(actorName)}</AvatarFallback>
              </Avatar>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                  <Link to={`/agents/${run.agentId}`} className="font-medium text-foreground transition-colors hover:underline">
                    {actorName}
                  </Link>
                  <span className="text-muted-foreground">run</span>
                  <Link
                    to={`/agents/${run.agentId}/runs/${run.runId}`}
                    className="inline-flex items-center rounded-md border border-border bg-accent/40 px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    {run.runId.slice(0, 8)}
                  </Link>
                  <span className={cn("font-medium", runStatusClass(run.status))}>
                    {formatRunStatusLabel(run.status)}
                  </span>
                  <a
                    href={`#run-${run.runId}`}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground hover:underline"
                  >
                    {timeAgo(runTimestamp(run))}
                  </a>
                </div>
              </div>
            </div>
          );
        }

        const comment = item.comment;
        return (
          <CommentCard
            key={comment.id}
            comment={comment}
            agentMap={agentMap}
            companyId={companyId}
            projectId={projectId}
            feedbackVote={feedbackVoteByTargetId?.get(comment.id) ?? null}
            feedbackDataSharingPreference={feedbackDataSharingPreference}
            feedbackTermsUrl={feedbackTermsUrl}
            onVote={onVote ? (vote, options) => onVote(comment.id, vote, options) : undefined}
            voting={votingTargetId === comment.id}
            highlightCommentId={highlightCommentId}
          />
        );
      })}
    </div>
  );
});

export const CommentThread = memo(function CommentThread({
  comments,
  queuedComments = [],
  linkedApprovals = [],
  feedbackVotes = [],
  feedbackDataSharingPreference = "prompt",
  feedbackTermsUrl = null,
  linkedRuns = [],
  timelineEvents = [],
  companyId,
  projectId,
  onApproveApproval,
  onRejectApproval,
  pendingApprovalAction = null,
  onVote,
  onAdd,
  agentMap,
  currentUserId,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  liveRunSlot,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions: providedMentions,
  onInterruptQueued,
  interruptingQueuedRunId = null,
  composerDisabledReason = null,
}: CommentThreadProps) {
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const [votingTargetId, setVotingTargetId] = useState<string | null>(null);
  const location = useLocation();
  const hasScrolledRef = useRef(false);

  const timeline = useMemo<TimelineItem[]>(() => {
    const commentItems: TimelineItem[] = comments.map((comment) => ({
      kind: "comment",
      id: comment.id,
      createdAtMs: new Date(comment.createdAt).getTime(),
      comment,
    }));
    const approvalItems: TimelineItem[] = linkedApprovals.map((approval) => ({
      kind: "approval",
      id: approval.id,
      createdAtMs: new Date(approval.createdAt).getTime(),
      approval,
    }));
    const eventItems: TimelineItem[] = timelineEvents.map((event) => ({
      kind: "event",
      id: event.id,
      createdAtMs: new Date(event.createdAt).getTime(),
      event,
    }));
    const runItems: TimelineItem[] = linkedRuns.map((run) => ({
      kind: "run",
      id: run.runId,
      createdAtMs: new Date(runTimestamp(run)).getTime(),
      run,
    }));
    return [...commentItems, ...approvalItems, ...eventItems, ...runItems].sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      if (a.kind === b.kind) return a.id.localeCompare(b.id);
      const kindOrder = {
        event: 0,
        approval: 1,
        comment: 2,
        run: 3,
      } as const;
      return kindOrder[a.kind] - kindOrder[b.kind];
    });
  }, [comments, linkedApprovals, timelineEvents, linkedRuns]);

  const feedbackVoteByTargetId = useMemo(() => {
    const map = new Map<string, FeedbackVoteValue>();
    for (const feedbackVote of feedbackVotes) {
      if (feedbackVote.targetType !== "issue_comment") continue;
      map.set(feedbackVote.targetId, feedbackVote.vote);
    }
    return map;
  }, [feedbackVotes]);

  // Build mention options from agent map (exclude terminated agents)
  const mentions = useMemo<MentionOption[]>(() => {
    if (providedMentions) return providedMentions;
    if (!agentMap) return [];
    return Array.from(agentMap.values())
      .filter((a) => a.status !== "terminated")
      .map((a) => ({
        id: `agent:${a.id}`,
        name: a.name,
        kind: "agent",
        agentId: a.id,
        agentIcon: a.icon,
      }));
  }, [agentMap, providedMentions]);

  // Scroll to comment when URL hash matches #comment-{id}
  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith("#comment-") || comments.length + queuedComments.length === 0) return;
    const commentId = hash.slice("#comment-".length);
    // Only scroll once per hash
    if (hasScrolledRef.current) return;
    const el = document.getElementById(`comment-${commentId}`);
    if (el) {
      hasScrolledRef.current = true;
      setHighlightCommentId(commentId);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Clear highlight after animation
      const timer = setTimeout(() => setHighlightCommentId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [location.hash, comments, queuedComments]);

  const handleFeedbackVote = useCallback(
    async (
      commentId: string,
      vote: FeedbackVoteValue,
      options?: { allowSharing?: boolean; reason?: string },
    ) => {
      if (!onVote) return;
      setVotingTargetId(commentId);
      try {
        await onVote(commentId, vote, options);
      } finally {
        setVotingTargetId(null);
      }
    },
    [onVote],
  );

  const timelineSection = useMemo(
    () => (
      <TimelineList
        timeline={timeline}
        agentMap={agentMap}
        currentUserId={currentUserId}
        companyId={companyId}
        projectId={projectId}
        onApproveApproval={onApproveApproval}
        onRejectApproval={onRejectApproval}
        pendingApprovalAction={pendingApprovalAction}
        feedbackVoteByTargetId={feedbackVoteByTargetId}
        feedbackDataSharingPreference={feedbackDataSharingPreference}
        onVote={onVote ? handleFeedbackVote : undefined}
        votingTargetId={votingTargetId}
        highlightCommentId={highlightCommentId}
        feedbackTermsUrl={feedbackTermsUrl}
      />
    ),
    [
      timeline, agentMap, currentUserId, companyId, projectId,
      onApproveApproval, onRejectApproval, pendingApprovalAction,
      feedbackVoteByTargetId, feedbackDataSharingPreference,
      onVote, handleFeedbackVote, votingTargetId, highlightCommentId,
      feedbackTermsUrl,
    ],
  );

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Timeline ({timeline.length + queuedComments.length})</h3>

      {timelineSection}

      {liveRunSlot}

      {queuedComments.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
              Queued Comments ({queuedComments.length})
            </h4>
            {onInterruptQueued && queuedComments[0]?.queueTargetRunId ? (
              <Button
                size="sm"
                variant="outline"
                className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                disabled={interruptingQueuedRunId === queuedComments[0].queueTargetRunId}
                onClick={() => void onInterruptQueued(queuedComments[0]!.queueTargetRunId!)}
              >
                {interruptingQueuedRunId === queuedComments[0].queueTargetRunId ? "Interrupting..." : "Interrupt"}
              </Button>
            ) : null}
          </div>
          <div className="space-y-3">
            {queuedComments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                agentMap={agentMap}
                companyId={companyId}
                projectId={projectId}
                highlightCommentId={highlightCommentId}
                queued
              />
            ))}
          </div>
        </div>
      )}

      {composerDisabledReason ? (
        <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          {composerDisabledReason}
        </div>
      ) : (
        <CommentComposer
          onAdd={onAdd}
          mentions={mentions}
          imageUploadHandler={imageUploadHandler}
          onAttachImage={onAttachImage}
          draftKey={draftKey}
          enableReassign={enableReassign}
          reassignOptions={reassignOptions}
          currentAssigneeValue={currentAssigneeValue}
          suggestedAssigneeValue={effectiveSuggestedAssigneeValue}
          agentMap={agentMap}
        />
      )}

    </div>
  );
});

CommentThread.displayName = "CommentThread";

/* ---- Isolated Composer (body state lives here, not in CommentThread) ---- */

interface CommentComposerProps {
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  mentions: MentionOption[];
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  enableReassign: boolean;
  reassignOptions: InlineEntityOption[];
  currentAssigneeValue: string;
  suggestedAssigneeValue: string;
  agentMap?: Map<string, Agent>;
}

const CommentComposer = memo(function CommentComposer({
  onAdd,
  mentions,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  enableReassign,
  reassignOptions,
  currentAssigneeValue,
  suggestedAssigneeValue,
  agentMap,
}: CommentComposerProps) {
  const [body, setBody] = useState("");
  const [reopen, setReopen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [reassignTarget, setReassignTarget] = useState(suggestedAssigneeValue);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
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
    setReassignTarget(suggestedAssigneeValue);
  }, [suggestedAssigneeValue]);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : null;
    const submittedBody = trimmed;

    setSubmitting(true);
    setBody("");
    try {
      await onAdd(submittedBody, reopen ? true : undefined, reassignment ?? undefined);
      if (draftKey) clearDraft(draftKey);
      setReopen(true);
      setReassignTarget(suggestedAssigneeValue);
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
      if (imageUploadHandler) {
        const url = await imageUploadHandler(file);
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

  const canSubmit = !submitting && !!body.trim();

  return (
    <div className="space-y-2">
      <MarkdownEditor
        ref={editorRef}
        value={body}
        onChange={setBody}
        placeholder="Leave a comment..."
        mentions={mentions}
        onSubmit={handleSubmit}
        imageUploadHandler={imageUploadHandler}
        contentClassName="min-h-[60px] text-sm"
      />
      <div className="flex items-center justify-end gap-3">
        {(imageUploadHandler || onAttachImage) && (
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
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={reopen}
            onChange={(e) => setReopen(e.target.checked)}
            className="rounded border-border"
          />
          Re-open
        </label>
        {enableReassign && reassignOptions.length > 0 && (
          <InlineEntitySelector
            value={reassignTarget}
            options={reassignOptions}
            placeholder="Assignee"
            noneLabel="No assignee"
            searchPlaceholder="Search assignees..."
            emptyMessage="No assignees found."
            onChange={setReassignTarget}
            className="text-xs h-8"
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
        )}
        <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
          {submitting ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
});
