import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_ROLE_LABELS,
  type Agent,
  type AskUserQuestionsAnswer,
  type AskUserQuestionsInteraction,
  type FeedbackVote,
  type FeedbackVoteValue,
  type IssueThreadInteraction,
  type RequestCheckboxConfirmationInteraction,
  type RequestConfirmationInteraction,
  type SuggestTasksInteraction,
} from "@paperclipai/shared";
import { AlertCircle, Loader2 } from "lucide-react";
import { IssueChatThread } from "./IssueChatThread";
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
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import type { IssueChatComment } from "../lib/issue-chat-messages";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/** Poll cadence for the issue-backed conversation while the surface is open. */
const SELECTED_AGENT_CHAT_POLL_MS = 3000;

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

export interface SelectedAgentChatViewProps {
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
  feedbackVotes?: FeedbackVote[];
  issueId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  currentUserId?: string | null;
  /** True while the first comments fetch is in flight (no data yet). */
  loading?: boolean;
  /** Surface a delivery/transport failure inline (CR8). */
  errorText?: string | null;
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
 * Presentational selected-agent chat surface. Renders the real-agent identity
 * header + switcher and delegates the message stream, interaction cards, and
 * live/active-run rows to the shared {@link IssueChatThread}. Data and handlers
 * are injected so the same view powers both the connected app surface and
 * Storybook state fixtures (idle / loading / active-run / error / history).
 */
export function SelectedAgentChatView({
  agents,
  targetAgentId,
  onTargetAgentChange,
  showAgentSwitcher = true,
  comments,
  interactions,
  liveRuns,
  activeRun,
  feedbackVotes,
  issueId,
  companyId,
  projectId,
  currentUserId,
  loading = false,
  errorText,
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
}: SelectedAgentChatViewProps) {
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a] as const)), [agents]);
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

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {/* Identity header — real selected agent (no board-concierge persona). */}
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

      {loading && comments.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading conversation" />
        </div>
      ) : (
        <div
          data-testid="selected-agent-chat-body"
          className="min-w-0 px-4 pb-4 pt-3"
        >
          <IssueChatThread
            variant="full"
            comments={comments}
            interactions={interactions}
            liveRuns={liveRuns}
            activeRun={activeRun}
            feedbackVotes={feedbackVotes}
            issueId={issueId}
            companyId={companyId}
            projectId={projectId}
            agentMap={agentMap}
            currentUserId={currentUserId}
            mentions={mentions}
            emptyMessage={
              emptyMessage ?? `Send ${targetName} a message to start the conversation.`
            }
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

export interface SelectedAgentChatProps {
  issueId: string;
  companyId: string;
  projectId?: string | null;
  /** Pre-loaded agents (e.g. from the page). Fetched if omitted. */
  agents?: readonly Agent[];
  /** Preferred initial target; defaults to the company CEO. */
  defaultTargetAgentId?: string | null;
  showAgentSwitcher?: boolean;
  currentUserId?: string | null;
  emptyMessage?: string;
  className?: string;
}

/**
 * Connected selected-agent chat. Issue-backed: durable history is the issue's
 * comments, live output is the target agent's active run, and next-step
 * choices are real issue-thread interactions. Sending wakes the target agent
 * (default CEO) via `selected-agent-chat/comments`.
 */
export function SelectedAgentChat({
  issueId,
  companyId,
  projectId,
  agents: providedAgents,
  defaultTargetAgentId,
  showAgentSwitcher = true,
  currentUserId,
  emptyMessage,
  className,
}: SelectedAgentChatProps) {
  const queryClient = useQueryClient();

  const { data: fetchedAgents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => import("../api/agents").then((m) => m.agentsApi.list(companyId)),
    enabled: !providedAgents,
  });
  const agents = providedAgents ?? fetchedAgents ?? [];

  const [targetAgentId, setTargetAgentId] = useState<string | null>(
    defaultTargetAgentId ?? null,
  );
  // Lock the default target onto the resolved CEO once agents load.
  useEffect(() => {
    if (targetAgentId) return;
    const fallback = resolveDefaultChatTarget(agents, defaultTargetAgentId);
    if (fallback) setTargetAgentId(fallback.id);
  }, [agents, defaultTargetAgentId, targetAgentId]);

  const [errorText, setErrorText] = useState<string | null>(null);

  const commentsQuery = useQuery({
    queryKey: queryKeys.issues.comments(issueId),
    queryFn: () => issuesApi.listComments(issueId),
    refetchInterval: SELECTED_AGENT_CHAT_POLL_MS,
  });

  const interactionsQuery = useQuery({
    queryKey: queryKeys.issues.interactions(issueId),
    queryFn: () => issuesApi.listInteractions(issueId),
    refetchInterval: SELECTED_AGENT_CHAT_POLL_MS,
  });

  const liveRunsQuery = useQuery({
    queryKey: targetAgentId
      ? queryKeys.issues.selectedAgentChatLiveRuns(issueId, targetAgentId)
      : queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId, targetAgentId),
    refetchInterval: SELECTED_AGENT_CHAT_POLL_MS,
    enabled: !!targetAgentId,
  });

  const activeRunQuery = useQuery({
    queryKey: targetAgentId
      ? queryKeys.issues.selectedAgentChatActiveRun(issueId, targetAgentId)
      : queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId, targetAgentId),
    refetchInterval: SELECTED_AGENT_CHAT_POLL_MS,
    enabled: !!targetAgentId,
  });

  const feedbackVotesQuery = useQuery({
    queryKey: queryKeys.issues.feedbackVotes(issueId),
    queryFn: () => issuesApi.listFeedbackVotes(issueId),
  });

  const invalidateRuns = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(issueId) });
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
      try {
        await issuesApi.addSelectedAgentChatComment(issueId, body, { targetAgentId });
        invalidateRuns();
      } catch (err) {
        setErrorText(
          err instanceof Error
            ? err.message
            : "The message couldn't be delivered. Please try again.",
        );
        // Rethrow so the composer keeps the typed message as a draft (CR8).
        throw err;
      }
    },
    [issueId, targetAgentId, invalidateRuns],
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

  return (
    <SelectedAgentChatView
      agents={agents}
      targetAgentId={targetAgentId}
      onTargetAgentChange={setTargetAgentId}
      showAgentSwitcher={showAgentSwitcher}
      comments={(commentsQuery.data ?? []) as IssueChatComment[]}
      interactions={interactionsQuery.data}
      liveRuns={liveRunsQuery.data}
      activeRun={activeRunQuery.data ?? null}
      feedbackVotes={feedbackVotesQuery.data}
      issueId={issueId}
      companyId={companyId}
      projectId={projectId}
      currentUserId={currentUserId}
      loading={commentsQuery.isLoading}
      errorText={errorText}
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
