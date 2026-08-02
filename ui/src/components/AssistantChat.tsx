import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_ROLE_LABELS,
  type Agent,
  type AskUserQuestionsAnswer,
  type AskUserQuestionsInteraction,
  type FeedbackVote,
  type FeedbackVoteValue,
  type IssueAttachment,
  type IssueRelationIssueSummary,
  type IssueThreadInteraction,
  type RequestCheckboxConfirmationInteraction,
  type RequestConfirmationInteraction,
  type SuggestTasksInteraction,
} from "@paperclipai/shared";
import { AlertCircle } from "lucide-react";
import { IssueChatThread, type IssueChatComposerHandle } from "./IssueChatThread";
import { AgentIcon } from "./AgentIconPicker";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MentionOption } from "./MarkdownEditor";
import { accessApi } from "../api/access";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import {
  buildCompanyUserLabelMap,
  buildCompanyUserProfileMap,
  type CompanyUserProfile,
} from "../lib/company-members";
import type { IssueChatComment, IssueChatTranscriptEntry } from "../lib/issue-chat-messages";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/** Poll cadence for the issue-backed assistant conversation while work is live. */
export const ASSISTANT_CHAT_ACTIVE_POLL_MS = 1500;
/** Poll cadence for the issue-backed assistant conversation while idle. */
export const ASSISTANT_CHAT_IDLE_POLL_MS = 8000;

export interface AssistantChatStarterPrompt {
  label: string;
  prompt: string;
}

export interface PendingAssistantChatComment {
  clientNonce: string;
  targetAgentId: string | null;
  body: string;
  comment: IssueChatComment;
  serverCommentId?: string | null;
}

export function resolveAssistantChatPollInterval(hasLiveRun: boolean) {
  return hasLiveRun ? ASSISTANT_CHAT_ACTIVE_POLL_MS : ASSISTANT_CHAT_IDLE_POLL_MS;
}

function isLiveRunStatus(status: string | null | undefined) {
  return status === "queued" || status === "running";
}

function hasLiveAssistantRun(
  liveRuns: readonly LiveRunForIssue[] | undefined,
  activeRun: ActiveRunForIssue | null | undefined,
) {
  return Boolean(activeRun && isLiveRunStatus(activeRun.status))
    || Boolean(liveRuns?.some((run) => isLiveRunStatus(run.status)));
}

function createClientNonce() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function buildStarterPrompts(companyName: string): AssistantChatStarterPrompt[] {
  return [
    {
      label: "Draft a Company Brief",
      prompt: `Draft a one-page Company Brief for ${companyName} - include our mission, team roster, and first priorities.`,
    },
    {
      label: "Create a hiring plan",
      prompt: `Create a hiring plan for ${companyName}. List the next roles to hire, in priority order, with a short rationale for each.`,
    },
    {
      label: "Outline our first 30 days",
      prompt: "Outline our first 30 days. Break it into weekly priorities with who owns what.",
    },
    {
      label: "Write an intro pitch",
      prompt: `Write a short intro pitch for ${companyName} that I could reuse for investors, customers, or recruits.`,
    },
  ];
}

function isOptimisticCommentMatched(
  serverComments: readonly IssueChatComment[],
  pending: PendingAssistantChatComment,
) {
  if (pending.serverCommentId) {
    return serverComments.some((comment) => comment.id === pending.serverCommentId);
  }
  const pendingCreatedAt = new Date(pending.comment.createdAt).getTime();
  return serverComments.some((comment) => {
    if (comment.body !== pending.body) return false;
    if (comment.authorType !== pending.comment.authorType) return false;
    if (pending.comment.authorUserId && comment.authorUserId !== pending.comment.authorUserId) {
      return false;
    }
    if (pending.comment.authorAgentId && comment.authorAgentId !== pending.comment.authorAgentId) {
      return false;
    }
    return new Date(comment.createdAt).getTime() >= pendingCreatedAt;
  });
}

export function mergeAssistantChatComments(
  serverComments: readonly IssueChatComment[],
  pendingComments: readonly PendingAssistantChatComment[],
): IssueChatComment[] {
  const unresolvedPending = pendingComments.filter(
    (pending) => !isOptimisticCommentMatched(serverComments, pending),
  );
  return [
    ...serverComments,
    ...unresolvedPending.map((pending) => pending.comment),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function createOptimisticComment({
  issueId,
  companyId,
  body,
  currentUserId,
  targetAgentId,
}: {
  issueId: string;
  companyId: string;
  body: string;
  currentUserId?: string | null;
  targetAgentId: string | null;
}): PendingAssistantChatComment {
  const clientNonce = createClientNonce();
  const now = new Date();
  return {
    clientNonce,
    targetAgentId,
    body,
    comment: {
      id: `optimistic:${clientNonce}`,
      companyId,
      issueId,
      authorType: "user",
      authorAgentId: null,
      authorUserId: currentUserId ?? null,
      createdByRunId: null,
      body,
      presentation: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    } as IssueChatComment,
  };
}

function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase()) || "A";
}

/**
 * Pick the default selected-agent chat target: the company CEO (matches the
 * server default for `selected-agent-chat/comments`), falling back to an
 * explicit preferred id, then the first non-terminated agent.
 */
export function resolveDefaultChatTarget(
  agents: readonly Agent[] | undefined,
  preferredAgentId?: string | null,
): Agent | null {
  if (!agents || agents.length === 0) return null;
  const active = agents.filter((a) => a.status !== "terminated");
  if (preferredAgentId) {
    const preferred = active.find((a) => a.id === preferredAgentId);
    if (preferred) return preferred;
  }
  const ceo = active.find((a) => a.role === "ceo");
  if (ceo) return ceo;
  return active[0] ?? agents[0] ?? null;
}

/** CEO pinned first, then the rest alphabetically — the switcher ordering. */
function orderInvokableAgents(agents: readonly Agent[]): Agent[] {
  return agents
    .filter((a) => a.status !== "terminated")
    .slice()
    .sort((a, b) => {
      if (a.role === "ceo" && b.role !== "ceo") return -1;
      if (b.role === "ceo" && a.role !== "ceo") return 1;
      return a.name.localeCompare(b.name);
    });
}

type InteractionAccept =
  | SuggestTasksInteraction
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction;

export interface AssistantChatViewProps {
  /** Agents available as chat targets (the switcher list + bubble identity). */
  agents: readonly Agent[];
  targetAgentId: string | null;
  onTargetAgentChange?: (agentId: string) => void;
  /** Hide the switcher (ship-behind-a-flag): identity still renders. */
  showAgentSwitcher?: boolean;
  comments: IssueChatComment[];
  interactions?: IssueThreadInteraction[];
  liveRuns?: LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  transcriptsByRunId?: ReadonlyMap<string, readonly IssueChatTranscriptEntry[]>;
  feedbackVotes?: FeedbackVote[];
  issueId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  backgroundWorkChildren?: IssueRelationIssueSummary[];
  suppressIssueStatusNotices?: boolean;
  companyName?: string | null;
  header?: ReactNode;
  starterPrompts?: AssistantChatStarterPrompt[];
  emptyState?: ReactNode;
  composerHint?: string | null;
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  /** True while the first comments fetch is in flight (no data yet). */
  loading?: boolean;
  /** Surface a delivery/transport failure inline (CR8). */
  errorText?: string | null;
  /** Non-error inline notice (e.g. delivered but the agent can't run here). */
  noticeText?: string | null;
  onRetry?: () => void;
  onSend: (body: string) => Promise<void>;
  onStopRun?: (runId: string) => Promise<void>;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onAcceptInteraction?: (
    interaction: InteractionAccept,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (interaction: InteractionAccept, reason?: string) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (interaction: AskUserQuestionsInteraction) => Promise<void> | void;
  emptyMessage?: string;
  className?: string;
}

/**
 * Presentational assistant chat surface. Renders the real-agent identity
 * header + switcher and delegates the message stream, interaction cards, and
 * live/active-run rows to the shared {@link IssueChatThread}. Data and handlers
 * are injected so the same view powers both the connected app surface and
 * Storybook state fixtures (idle / loading / active-run / error / history).
 */
export function AssistantChatView({
  agents,
  targetAgentId,
  onTargetAgentChange,
  showAgentSwitcher = true,
  comments,
  interactions,
  liveRuns,
  activeRun,
  transcriptsByRunId,
  feedbackVotes,
  issueId,
  companyId,
  projectId,
  currentUserId,
  userLabelMap,
  userProfileMap,
  backgroundWorkChildren = [],
  suppressIssueStatusNotices,
  companyName = null,
  header,
  starterPrompts: providedStarterPrompts,
  emptyState: providedEmptyState,
  composerHint,
  imageUploadHandler,
  onAttachImage,
  loading = false,
  errorText,
  noticeText,
  onRetry,
  onSend,
  onStopRun,
  onVote,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  emptyMessage,
  className,
}: AssistantChatViewProps) {
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a] as const)), [agents]);
  const composerRef = useRef<IssueChatComposerHandle>(null);
  const targetAgent = targetAgentId ? agentMap.get(targetAgentId) ?? null : null;
  const invokableAgents = useMemo(() => orderInvokableAgents(agents), [agents]);

  const mentions = useMemo<MentionOption[]>(
    () =>
      invokableAgents.map((a) => ({
        id: `agent:${a.id}`,
        name: a.name,
        kind: "agent",
        agentId: a.id,
        agentIcon: a.icon,
      })),
    [invokableAgents],
  );

  const handleAdd = useCallback(
    (body: string) => onSend(body),
    [onSend],
  );

  const targetName = targetAgent?.name ?? "Assistant";
  const targetRole = targetAgent ? roleLabels[targetAgent.role] ?? targetAgent.role : null;
  const canSwitch = showAgentSwitcher && invokableAgents.length > 1 && !!onTargetAgentChange;
  const starterPrompts = useMemo(
    () => providedStarterPrompts ?? buildStarterPrompts(companyName?.trim() || "this company"),
    [companyName, providedStarterPrompts],
  );
  const starterPromptState = starterPrompts.length > 0 ? (
    <div data-testid="selected-agent-chat-starter-prompts" className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {starterPrompts.map((prompt) => (
          <button
            key={prompt.label}
            type="button"
            className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => composerRef.current?.setDraft(prompt.prompt)}
          >
            {prompt.label}
          </button>
        ))}
      </div>
    </div>
  ) : undefined;
  const emptyState = providedEmptyState ?? starterPromptState;

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {header ?? (
        <div
          data-testid="selected-agent-chat-header"
          className="relative flex shrink-0 items-center gap-2 px-4 py-3"
        >
          <div
            className="pointer-events-none absolute bottom-0 left-0 right-0 h-px bg-border"
            aria-hidden
          />
          {canSwitch ? (
            <Select
              value={targetAgentId ?? undefined}
              onValueChange={(value) => onTargetAgentChange?.(value)}
            >
              <SelectTrigger
                size="sm"
                className="h-auto w-auto min-w-0 max-w-full gap-2 px-2 py-1.5"
                aria-label="Choose chat agent"
              >
                <SelectValue placeholder="Choose agent" />
              </SelectTrigger>
              <SelectContent align="start">
                {invokableAgents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="flex items-center gap-2">
                      <AgentIcon icon={a.icon} className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{a.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {roleLabels[a.role] ?? a.role}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <Avatar size="sm" className="shrink-0">
                <AvatarFallback>
                  {targetAgent?.icon ? (
                    <AgentIcon icon={targetAgent.icon} className="h-3.5 w-3.5" />
                  ) : (
                    agentInitials(targetName)
                  )}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{targetName}</div>
                {targetRole ? (
                  <div className="truncate text-xs text-muted-foreground">{targetRole}</div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}

      {errorText ? (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="break-words">{errorText}</p>
            <p className="mt-0.5 text-xs text-destructive/80">
              Your message was kept in the composer so you can try again.
            </p>
          </div>
          {onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={onRetry}
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {noticeText ? (
        <div
          role="status"
          data-testid="assistant-chat-notice"
          className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <p className="min-w-0 flex-1 break-words">{noticeText}</p>
        </div>
      ) : null}

      {loading && comments.length === 0 ? (
        <div
          data-testid="assistant-chat-skeleton"
          className="flex flex-1 flex-col gap-4 px-4 py-4"
          aria-label="Loading conversation"
        >
          <div className="h-16 w-2/3 animate-pulse rounded-md bg-muted" />
          <div className="ml-auto h-14 w-3/5 animate-pulse rounded-md bg-muted" />
          <div className="h-20 w-4/5 animate-pulse rounded-md bg-muted" />
        </div>
      ) : (
        <div
          data-testid="selected-agent-chat-body"
          // Own scroll container: chat scrolling (including the initial
          // scroll-to-latest) must never move the page or the sidebar.
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-4 pt-3"
        >
          <IssueChatThread
            preset="assistant"
            variant="full"
            composerRef={composerRef}
            comments={comments}
            interactions={interactions}
            liveRuns={liveRuns}
            activeRun={activeRun}
            transcriptsByRunId={transcriptsByRunId}
            feedbackVotes={feedbackVotes}
            issueId={issueId}
            companyId={companyId}
            projectId={projectId}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            userProfileMap={userProfileMap}
            backgroundWorkChildren={backgroundWorkChildren}
            suppressIssueStatusNotices={suppressIssueStatusNotices}
            mentions={mentions}
            emptyMessage={
              emptyMessage ?? `Send ${targetName} a message to start the conversation.`
            }
            emptyState={emptyState}
            composerHint={composerHint}
            imageUploadHandler={imageUploadHandler}
            onAttachImage={onAttachImage}
            onAdd={handleAdd}
            onStopRun={onStopRun}
            onVote={onVote}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            onSubmitInteractionAnswers={onSubmitInteractionAnswers}
            onCancelInteraction={onCancelInteraction}
          />
        </div>
      )}
    </div>
  );
}

export interface AssistantChatProps {
  issueId: string;
  companyId: string;
  projectId?: string | null;
  /** Pre-loaded agents (e.g. from the page). Fetched if omitted. */
  agents?: readonly Agent[];
  /** Preferred initial target; defaults to the company CEO. */
  targetAgentId?: string | null;
  showAgentSwitcher?: boolean;
  companyName?: string | null;
  currentUserId?: string | null;
  starterPrompts?: AssistantChatStarterPrompt[];
  header?: ReactNode;
  emptyState?: ReactNode;
  emptyMessage?: string;
  onMessageSent?: () => void | Promise<void>;
  className?: string;
}

/**
 * Connected assistant chat. Issue-backed: durable history is the issue's
 * comments, live output is the target agent's active run, and next-step
 * choices are real issue-thread interactions. Sending wakes the target agent
 * (default CEO) via `selected-agent-chat/comments`.
 */
export function AssistantChat({
  issueId,
  companyId,
  projectId,
  agents: providedAgents,
  targetAgentId: preferredTargetAgentId,
  showAgentSwitcher = true,
  companyName = null,
  currentUserId,
  starterPrompts,
  header,
  emptyState,
  emptyMessage,
  onMessageSent,
  className,
}: AssistantChatProps) {
  const queryClient = useQueryClient();

  const { data: fetchedAgents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => import("../api/agents").then((m) => m.agentsApi.list(companyId)),
    enabled: !providedAgents,
  });
  const agents = providedAgents ?? fetchedAgents ?? [];

  const [targetAgentId, setTargetAgentId] = useState<string | null>(
    preferredTargetAgentId ?? null,
  );
  useEffect(() => {
    if (preferredTargetAgentId) setTargetAgentId(preferredTargetAgentId);
  }, [preferredTargetAgentId]);

  // Lock the default target onto the resolved CEO once agents load.
  useEffect(() => {
    if (targetAgentId) return;
    const fallback = resolveDefaultChatTarget(agents, preferredTargetAgentId);
    if (fallback) setTargetAgentId(fallback.id);
  }, [agents, preferredTargetAgentId, targetAgentId]);

  const [errorText, setErrorText] = useState<string | null>(null);
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const [pendingComments, setPendingComments] = useState<PendingAssistantChatComment[]>([]);

  // Resolve human author names/avatars (issue-chat parity: "Dotta", not "You").
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const liveRunsQuery = useQuery({
    queryKey: targetAgentId
      ? queryKeys.issues.selectedAgentChatLiveRuns(issueId, targetAgentId)
      : queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId, targetAgentId),
    refetchInterval: (query) =>
      resolveAssistantChatPollInterval(hasLiveAssistantRun(query.state.data as LiveRunForIssue[] | undefined, null)),
    enabled: !!targetAgentId,
  });

  const activeRunQuery = useQuery({
    queryKey: targetAgentId
      ? queryKeys.issues.selectedAgentChatActiveRun(issueId, targetAgentId)
      : queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId, targetAgentId),
    refetchInterval: (query) =>
      resolveAssistantChatPollInterval(hasLiveAssistantRun(liveRunsQuery.data, query.state.data as ActiveRunForIssue | null | undefined)),
    enabled: !!targetAgentId,
  });

  const assistantPollInterval = resolveAssistantChatPollInterval(
    hasLiveAssistantRun(liveRunsQuery.data, activeRunQuery.data),
  );

  const commentsQuery = useQuery({
    queryKey: queryKeys.issues.comments(issueId),
    queryFn: () => issuesApi.listComments(issueId),
    refetchInterval: assistantPollInterval,
  });

  const interactionsQuery = useQuery({
    queryKey: queryKeys.issues.interactions(issueId),
    queryFn: () => issuesApi.listInteractions(issueId),
    refetchInterval: assistantPollInterval,
  });

  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
    refetchInterval: assistantPollInterval,
  });

  const feedbackVotesQuery = useQuery({
    queryKey: queryKeys.issues.feedbackVotes(issueId),
    queryFn: () => issuesApi.listFeedbackVotes(issueId),
  });

  const backgroundWorkChildren = useMemo(() => {
    const seen = new Set<string>();
    const children: IssueRelationIssueSummary[] = [];
    for (const child of [
      ...(issueQuery.data?.blockedBy ?? []),
      ...(issueQuery.data?.blocks ?? []),
    ]) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      children.push(child);
    }
    return children;
  }, [issueQuery.data?.blockedBy, issueQuery.data?.blocks]);

  const comments = useMemo(
    () => mergeAssistantChatComments((commentsQuery.data ?? []) as IssueChatComment[], pendingComments),
    [commentsQuery.data, pendingComments],
  );

  useEffect(() => {
    const serverComments = (commentsQuery.data ?? []) as IssueChatComment[];
    if (serverComments.length === 0) return;
    setPendingComments((current) =>
      current.filter((pending) => !isOptimisticCommentMatched(serverComments, pending)),
    );
  }, [commentsQuery.data]);

  const hasOpenBackgroundWork = backgroundWorkChildren.some(
    (child) => child.status !== "done" && child.status !== "cancelled",
  );

  const invalidateRuns = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(issueId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    if (targetAgentId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.selectedAgentChatLiveRuns(issueId, targetAgentId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.selectedAgentChatActiveRun(issueId, targetAgentId),
      });
    }
  }, [issueId, queryClient, targetAgentId]);

  const handleSend = useCallback(
    async (body: string) => {
      setErrorText(null);
      setNoticeText(null);
      const optimistic = createOptimisticComment({
        issueId,
        companyId,
        body,
        currentUserId,
        targetAgentId,
      });
      setPendingComments((current) => [...current, optimistic]);
      try {
        const response = await issuesApi.addSelectedAgentChatComment(issueId, body, { targetAgentId });
        setPendingComments((current) =>
          current.map((pending) =>
            pending.clientNonce === optimistic.clientNonce
              ? {
                  ...pending,
                  comment: response.comment as IssueChatComment,
                  serverCommentId: response.comment.id,
                }
              : pending,
          ),
        );
        if (response.wake?.suppressed) {
          const agentName = response.targetAgent?.name ?? "The agent";
          setNoticeText(
            response.wake.reason === "worktree_instance"
              ? `Message saved, but agent runs are disabled on this worktree instance — ${agentName} won't reply here.`
              : `Message saved, but agent runs are paused on this instance right now — ${agentName} can't reply yet.`,
          );
        }
        await onMessageSent?.();
        invalidateRuns();
      } catch (err) {
        setPendingComments((current) =>
          current.filter((pending) => pending.clientNonce !== optimistic.clientNonce),
        );
        setErrorText(
          err instanceof Error
            ? err.message
            : "The message couldn't be delivered. Please try again.",
        );
        // Rethrow so the composer keeps the typed message as a draft.
        throw err;
      }
    },
    [issueId, companyId, currentUserId, targetAgentId, onMessageSent, invalidateRuns],
  );

  const handleStopRun = useCallback(
    async (runId: string) => {
      await heartbeatsApi.cancel(runId);
      invalidateRuns();
    },
    [invalidateRuns],
  );

  const handleVote = useCallback(
    async (
      commentId: string,
      vote: FeedbackVoteValue,
      options?: { allowSharing?: boolean; reason?: string },
    ) => {
      await issuesApi.upsertFeedbackVote(issueId, {
        targetType: "issue_comment",
        targetId: commentId,
        vote,
        reason: options?.reason,
        allowSharing: options?.allowSharing,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.feedbackVotes(issueId) });
    },
    [issueId, queryClient],
  );

  const handleAcceptInteraction = useCallback(
    async (interaction: InteractionAccept, selectedClientKeys?: string[], selectedOptionIds?: string[]) => {
      await issuesApi.acceptInteraction(issueId, interaction.id, {
        selectedClientKeys,
        selectedOptionIds,
      });
      invalidateRuns();
    },
    [issueId, invalidateRuns],
  );

  const handleRejectInteraction = useCallback(
    async (interaction: InteractionAccept, reason?: string) => {
      await issuesApi.rejectInteraction(issueId, interaction.id, reason);
      invalidateRuns();
    },
    [issueId, invalidateRuns],
  );

  const handleSubmitInteractionAnswers = useCallback(
    async (interaction: AskUserQuestionsInteraction, answers: AskUserQuestionsAnswer[]) => {
      await issuesApi.respondToInteraction(issueId, interaction.id, { answers });
      invalidateRuns();
    },
    [issueId, invalidateRuns],
  );

  const handleCancelInteraction = useCallback(
    async (interaction: AskUserQuestionsInteraction) => {
      await issuesApi.cancelInteraction(issueId, interaction.id);
      invalidateRuns();
    },
    [issueId, invalidateRuns],
  );

  const handleImageUpload = useCallback(async (file: File) => {
    const attachment = await issuesApi.uploadAttachment(companyId, issueId, file);
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    return attachment.contentPath;
  }, [companyId, issueId, queryClient]);

  const handleAttachFile = useCallback(async (file: File) => {
    const attachment = await issuesApi.uploadAttachment(companyId, issueId, file);
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    return attachment;
  }, [companyId, issueId, queryClient]);

  return (
    <AssistantChatView
      agents={agents}
      targetAgentId={targetAgentId}
      onTargetAgentChange={setTargetAgentId}
      showAgentSwitcher={showAgentSwitcher}
      comments={comments}
      interactions={interactionsQuery.data}
      liveRuns={liveRunsQuery.data}
      activeRun={activeRunQuery.data ?? null}
      feedbackVotes={feedbackVotesQuery.data}
      issueId={issueId}
      companyId={companyId}
      projectId={projectId}
      currentUserId={currentUserId}
      userLabelMap={userLabelMap}
      userProfileMap={userProfileMap}
      backgroundWorkChildren={backgroundWorkChildren}
      suppressIssueStatusNotices
      companyName={companyName}
      header={header}
      starterPrompts={starterPrompts}
      emptyState={emptyState}
      composerHint={hasOpenBackgroundWork ? "Ask me anything while I work on this." : undefined}
      imageUploadHandler={handleImageUpload}
      onAttachImage={handleAttachFile}
      loading={commentsQuery.isLoading}
      errorText={errorText}
      noticeText={noticeText}
      onRetry={errorText ? () => setErrorText(null) : undefined}
      onSend={handleSend}
      onStopRun={handleStopRun}
      onVote={handleVote}
      onAcceptInteraction={handleAcceptInteraction}
      onRejectInteraction={handleRejectInteraction}
      onSubmitInteractionAnswers={handleSubmitInteractionAnswers}
      onCancelInteraction={handleCancelInteraction}
      emptyMessage={emptyMessage}
      className={className}
    />
  );
}
