import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RESPONSIBILITY_AUTOMATION_LEVEL_LABEL,
  RESPONSIBILITY_AUTOMATION_LEVELS,
  responsibilityAutomationPercent,
  type AutomationCandidate,
  type AutomationTrigger,
  type ResponsibilityAutomation,
  type ResponsibilityAutomationItem,
  type ResponsibilityAutomationLevel,
  type ResponsibilityAutomationOverview,
  type ResponsibilityAutomationStalled,
  type ResponsibilityWithRollup,
} from "@paperclipai/shared";
import { Bot, CirclePause, Hand, MessagesSquare, Pause, Play, Repeat, Repeat1, Trash2, Wrench, X, type LucideIcon } from "lucide-react";
import { describeError } from "@/api/errors";
import { responsibilitiesApi } from "@/api/responsibilities";
import { routineSuggestionsApi } from "@/api/routine-suggestions";
import { routinesApi } from "@/api/routines";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { responsibilityPath, routinePath } from "@/lib/responsibilities";
import {
  automationAreaGroups,
  automationById,
  automationCountsLine,
  automationLevelCounts,
  automationSentence,
  automationShareLabel,
  automationStartWords,
  candidateReasonWords,
  conversationButtonLabel,
  noCandidatesWords,
  readDismissedCandidates,
  remainingCandidateCount,
  stalledWords,
  visibleCandidates,
  writeDismissedCandidates,
  type AutomationAreaGroup,
} from "@/lib/responsibility-automation";
import { activeResponsibilities } from "@/lib/responsibility-views";
import { Link } from "@/lib/router";
import { useOpenAutomationConversation } from "@/hooks/useOpenAutomationConversation";
import { cn, issueUrl } from "@/lib/utils";
import { AutomationStartIcon, webhookSecuredWords } from "./AutomationParts";
import { BoardAreaHeader } from "./BoardLayout";
import { localTimeZone, MakeRoutineDialog, type RoutineTaskTarget } from "./MakeRoutineDialog";
import { ResponsibilitiesEmpty } from "./ResponsibilitiesEmpty";
import { ProposalsNotice } from "./ResponsibilityViewParts";
import type { DashboardViewProps } from "./view-props";

const LEVEL_FILL_VAR: Record<ResponsibilityAutomationLevel, string> = {
  manual: "--responsibility-automation-manual",
  some_automated: "--responsibility-automation-some",
  mostly_automated: "--responsibility-automation-mostly",
  automated: "--responsibility-automation-automated",
};

/** One glyph per level, so the level never rests on colour alone. */
const LEVEL_ICON: Record<ResponsibilityAutomationLevel, LucideIcon> = {
  manual: Hand,
  some_automated: Repeat1,
  mostly_automated: Repeat,
  automated: Bot,
};

/** The hint's trigger, hedged: it is a suggestion the agent refines. */
const HINT_LABEL: Record<AutomationTrigger, string> = {
  schedule: "Could run on a schedule",
  webhook: "Could start from a webhook",
  standing_check: "Could be a standing check",
};

/** Points the shared `.status-chip` / `.status-fill` recipes at a level's hue. */
function levelStyle(level: ResponsibilityAutomationLevel): CSSProperties {
  return { "--sc": `var(${LEVEL_FILL_VAR[level]})` } as CSSProperties;
}

function levelIconColor(level: ResponsibilityAutomationLevel): string {
  return level === "manual" ? "var(--responsibility-automation-icon-manual)" : "var(--responsibility-automation-icon-automated)";
}

/**
 * Suggested tasks the person said do not repeat. Prototype: kept in this
 * browser's local storage per company (see `readDismissedCandidates`); the
 * view works the same without storage, for this visit only.
 */
function useDismissedCandidates(companyId: string): [ReadonlySet<string>, (issueId: string) => void] {
  const [state, setState] = useState<{ companyId: string; ids: ReadonlySet<string> }>(() => ({ companyId, ids: readDismissedCandidates(companyId) }));
  // Another organization's choices when the page switches company.
  const dismissed = useMemo(
    () => (state.companyId === companyId ? state.ids : readDismissedCandidates(companyId)),
    [state, companyId],
  );
  const dismiss = useCallback((issueId: string) => {
    setState((current) => {
      const next = new Set(current.companyId === companyId ? current.ids : readDismissedCandidates(companyId));
      next.add(issueId);
      writeDismissedCandidates(companyId, next);
      return { companyId, ids: next };
    });
  }, [companyId]);
  return [dismissed, dismiss];
}

/** The level in words with its glyph: "Some automated". */
function LevelLabel({ level, className }: { level: ResponsibilityAutomationLevel; className?: string }) {
  const Icon = LEVEL_ICON[level];
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground", className)} data-automation-level-label="">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" style={{ color: levelIconColor(level) }} />
      <span className="truncate">{RESPONSIBILITY_AUTOMATION_LEVEL_LABEL[level]}</span>
    </span>
  );
}

/** One proportional bar; each level takes its share of the responsibilities. */
function LevelBar({ counts }: { counts: Record<ResponsibilityAutomationLevel, number> }) {
  const total = RESPONSIBILITY_AUTOMATION_LEVELS.reduce((sum, level) => sum + counts[level], 0);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true" data-automation-level-bar="">
      {total > 0
        ? RESPONSIBILITY_AUTOMATION_LEVELS.map((level) =>
            counts[level] > 0 ? (
              <div
                key={level}
                data-level={level}
                className="status-fill h-full"
                style={{ ...levelStyle(level), flexGrow: counts[level], flexBasis: 0 }}
              />
            ) : null,
          )
        : null}
    </div>
  );
}

/**
 * "How much runs without you": how many responsibilities are at each level
 * over one split bar (each count filters the rows), the automations running
 * and the manual tasks, and one plain sentence.
 */
function AutomationSummary({
  counts,
  read,
  dismissed,
  filter,
  onToggle,
  onClear,
}: {
  counts: Record<ResponsibilityAutomationLevel, number>;
  read: ResponsibilityAutomationOverview;
  dismissed: ReadonlySet<string>;
  filter: ReadonlySet<ResponsibilityAutomationLevel>;
  onToggle: (level: ResponsibilityAutomationLevel) => void;
  onClear: () => void;
}) {
  const total = RESPONSIBILITY_AUTOMATION_LEVELS.reduce((sum, level) => sum + counts[level], 0);
  const sentence = automationSentence({ total, manual: counts.manual, candidates: remainingCandidateCount(read, dismissed) });
  const { automations, manualTasks } = read.totals;
  return (
    <Card elevation="low" className="gap-4 px-5 py-4" aria-labelledby="responsibility-automation-heading" data-automation-summary="">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="responsibility-automation-heading" className="text-sm font-semibold text-foreground">
          How much runs without you
        </h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {total === 1 ? "1 responsibility" : `${total} responsibilities`}
        </p>
      </div>
      <LevelBar counts={counts} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Show responsibilities by how automated they are">
        {RESPONSIBILITY_AUTOMATION_LEVELS.map((level) => {
          const pressed = filter.has(level);
          return (
            <button
              key={level}
              type="button"
              aria-pressed={pressed}
              disabled={counts[level] === 0 && !pressed}
              onClick={() => onToggle(level)}
              className={cn(
                "flex min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60",
                pressed ? "border-ring bg-accent/60" : "border-transparent hover:bg-accent/40",
              )}
              data-level-count={level}
            >
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="status-fill size-2 shrink-0 rounded-full" style={levelStyle(level)} aria-hidden="true" />
                <span className="truncate">{RESPONSIBILITY_AUTOMATION_LEVEL_LABEL[level]}</span>
              </span>
              <span className="text-2xl font-semibold tabular-nums text-foreground">{counts[level]}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <p className="text-sm text-foreground" data-automation-sentence="">{sentence}</p>
        <p className="flex flex-wrap items-center gap-x-1 text-xs tabular-nums text-muted-foreground" data-automation-totals="">
          <span>
            {automations === 1 ? "1 automation running" : `${automations} automations running`}
            <span aria-hidden="true"> · </span>
            {manualTasks === 1 ? "1 manual task" : `${manualTasks} manual tasks`} in the last {read.recentDays} days
          </span>
          {filter.size > 0 ? (
            <Button type="button" variant="link" size="xs" className="h-auto px-1 text-xs" onClick={onClear} data-automation-show-all="">
              Show all
            </Button>
          ) : null}
        </p>
      </div>
    </Card>
  );
}

interface RowActions {
  onSetUpByHand: (candidate: AutomationCandidate, responsibilityId: string) => void;
  onDismiss: (candidate: AutomationCandidate) => void;
  onMade: (message: string) => void;
}

async function refreshAutomation(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all }),
    queryClient.invalidateQueries({ queryKey: ["routines"] }),
    queryClient.invalidateQueries({ queryKey: ["issues", "interactions"] }),
  ]);
}

/**
 * One manual task that could be automated: its title (opens it), the instant
 * suggestion (which trigger might fit, and one line of why) or why it is
 * listed, and the actions: talk it through with the responsible agent (the
 * one primary button), set it up by hand, or say it doesn't repeat. With an
 * agent's pending routine offer: accept it, change it first, or no thanks.
 */
function CandidateRow({
  candidate,
  responsibilityId,
  agentName,
  now,
  actions,
}: {
  candidate: AutomationCandidate;
  responsibilityId: string;
  agentName: (id: string) => string | undefined;
  now: Date;
  actions: RowActions;
}) {
  const queryClient = useQueryClient();
  const conversation = useOpenAutomationConversation();
  const offer = candidate.pendingOffer;
  const hint = candidate.hint;
  const reason = hint ? null : candidateReasonWords(candidate, agentName, now);
  const who = candidate.responsibleAgentId ? agentName(candidate.responsibleAgentId) ?? "your agent" : null;
  const talk = () => conversation.open({
    issueId: candidate.issueId,
    agentId: candidate.responsibleAgentId,
    responsibilityId,
    conversation: candidate.conversation,
  });
  const accept = useMutation({
    mutationFn: () => routineSuggestionsApi.accept(candidate.issueId, offer!.interactionId, localTimeZone()),
    onSuccess: async (response) => {
      actions.onMade(`“${response.routine.title}” is automated now: ${offer!.cadenceLabel}.`);
      await refreshAutomation(queryClient);
    },
  });
  const decline = useMutation({
    mutationFn: () => routineSuggestionsApi.decline(candidate.issueId, offer!.interactionId),
    onSettled: () => refreshAutomation(queryClient),
  });
  const dismiss = () => {
    actions.onDismiss(candidate);
    if (offer) decline.mutate();
  };
  const error = conversation.error ?? accept.error;
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0 @3xl:flex-row @3xl:items-start @3xl:justify-between @3xl:gap-4"
      data-candidate-id={candidate.issueId}
      data-candidate-trigger={hint?.trigger ?? "none"}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          to={issueUrl({ id: candidate.issueId, identifier: candidate.identifier })}
          className="min-w-0 truncate text-sm text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={candidate.title}
        >
          {candidate.title}
        </Link>
        {offer ? (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-candidate-offer="">
            <AutomationStartIcon kind="schedule" />
            <span className="truncate">{agentName(offer.agentId ?? "") ?? "Your agent"} offered to repeat it: {offer.cadenceLabel}</span>
          </p>
        ) : hint ? (
          <div className="flex min-w-0 flex-col gap-0.5" data-candidate-hint={hint.trigger}>
            <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
              <AutomationStartIcon kind={hint.trigger} />
              <span className="truncate">
                {HINT_LABEL[hint.trigger]}
                {hint.cadenceLabel ? <span className="font-normal text-muted-foreground"> · {hint.cadenceLabel}</span> : null}
              </span>
            </p>
            <p className="text-xs text-muted-foreground" data-candidate-why="">{hint.why}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-candidate-why="">
            {reason ? `${reason}. ` : null}
            {who ? `How it could run is unclear from the title; work it out with ${who}.` : "How it could run is unclear from the title."}
          </p>
        )}
        {candidate.conversation ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-candidate-conversation={candidate.conversation.state}>
            <MessagesSquare aria-hidden="true" className="size-3 shrink-0" />
            {candidate.conversation.state === "proposal_waiting"
              ? `${agentName(candidate.conversation.agentId ?? "") ?? "Your agent"} has proposed an automation`
              : `Talking it through with ${agentName(candidate.conversation.agentId ?? "") ?? "your agent"}`}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {conversation.error ? "Couldn’t open the conversation." : "Couldn’t accept the offer."} {describeError(error).body}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1" data-candidate-actions="">
        {offer ? (
          <>
            <Button type="button" size="xs" disabled={accept.isPending} onClick={() => accept.mutate()}>
              <Repeat aria-hidden="true" />
              {accept.isPending ? "Accepting…" : "Accept"}
            </Button>
            <Button type="button" size="xs" variant="ghost" disabled={accept.isPending} onClick={() => actions.onSetUpByHand(candidate, responsibilityId)}>
              Change
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="xs"
              disabled={conversation.isPending || (!candidate.conversation && !candidate.responsibleAgentId)}
              title={!candidate.conversation && !candidate.responsibleAgentId ? "No agent can take this; set it up by hand" : undefined}
              onClick={talk}
              data-automate-with-agent=""
            >
              <MessagesSquare aria-hidden="true" />
              {conversation.isPending ? "Opening…" : conversationButtonLabel(candidate, agentName)}
            </Button>
            <Button type="button" size="xs" variant="ghost" className="text-muted-foreground" onClick={() => actions.onSetUpByHand(candidate, responsibilityId)} data-set-up-by-hand="">
              <Wrench aria-hidden="true" />
              Set up by hand
            </Button>
          </>
        )}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={offer ? `No thanks to repeating ${candidate.title}` : `${candidate.title} doesn't repeat`}
          title={offer ? "No thanks" : "Doesn't repeat"}
          onClick={dismiss}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/** Pause, resume or remove a standing check. Removing archives it; the routine's page can restore it. */
function StandingCheckActions({ routineId, title, paused }: { routineId: string; title: string; paused: boolean }) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (status: "active" | "paused" | "archived") => routinesApi.update(routineId, { status }),
    onSettled: () => refreshAutomation(queryClient),
  });
  return (
    <span className="flex items-center gap-0.5" data-standing-check-actions="">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground"
        disabled={change.isPending}
        aria-label={paused ? `Resume ${title}` : `Pause ${title}`}
        title={paused ? "Resume" : "Pause"}
        onClick={() => change.mutate(paused ? "active" : "paused")}
      >
        {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground"
        disabled={change.isPending}
        aria-label={`Remove ${title}`}
        title="Remove"
        onClick={() => change.mutate("archived")}
      >
        <Trash2 aria-hidden="true" />
      </Button>
      {change.error ? <span role="alert" className="sr-only">Couldn’t change it. {describeError(change.error).body}</span> : null}
    </span>
  );
}

/** One running automation: how it starts (icon and words), what it is, who runs it, and what happened last. */
function AutomationEntry({ item, agentName, now }: { item: ResponsibilityAutomationItem; agentName: (id: string) => string | undefined; now: Date }) {
  const words = automationStartWords(item, now);
  const who = agentName(item.assigneeAgentId) ?? "An agent";
  return (
    <li className="flex min-w-0 items-start gap-2" data-automation-id={item.id} data-automation-start={item.start.kind}>
      <AutomationStartIcon kind={item.start.kind} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-start justify-between gap-1">
          <Link
            to={routinePath(item.id)}
            className="min-w-0 truncate text-sm text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={item.title}
          >
            {item.title}
          </Link>
          {item.start.kind === "standing_check" ? <StandingCheckActions routineId={item.id} title={item.title} paused={false} /> : null}
        </div>
        <span className="text-xs text-muted-foreground" data-automation-start-words="">
          {words.label}
          {words.detail ? ` · ${words.detail}` : null}
          {` · ${who}`}
          {item.otherStarts > 0 ? ` · +${item.otherStarts} more ${item.otherStarts === 1 ? "way" : "ways"} to start` : null}
        </span>
        {words.status ? (
          <span className="text-xs text-muted-foreground" data-automation-status="">
            {words.status}
            {item.start.kind === "standing_check" && item.start.lastResult?.issue ? (
              <>
                {" · "}
                <Link
                  to={issueUrl({ id: item.start.lastResult.issue.id, identifier: item.start.lastResult.issue.identifier })}
                  className="underline-offset-4 hover:underline"
                >
                  {item.start.lastResult.issue.identifier ?? item.start.lastResult.issue.title}
                </Link>
              </>
            ) : null}
          </span>
        ) : null}
        {item.start.kind === "webhook" && item.start.webhookUrl ? (
          <span className="flex min-w-0 flex-col text-xs text-muted-foreground" data-automation-webhook="">
            <span className="truncate font-mono" title={item.start.webhookUrl}>POST {item.start.webhookUrl}</span>
            <span>{webhookSecuredWords(item.start.signingMode)}</span>
          </span>
        ) : null}
      </div>
    </li>
  );
}

function StalledEntry({ item, agentName }: { item: ResponsibilityAutomationStalled; agentName: (id: string) => string | undefined }) {
  return (
    <li className="flex min-w-0 items-start gap-2 text-xs" data-automation-stalled={item.reason}>
      <CirclePause aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-(--status-task-icon-todo)" />
      <div className="flex min-w-0 flex-1 items-start justify-between gap-1">
        <span className="min-w-0">
          <Link to={routinePath(item.id)} className="text-foreground hover:underline" title={item.title}>{item.title}</Link>
          <span className="text-muted-foreground"> · {stalledWords(item, agentName)}</span>
        </span>
        {item.startKind === "standing_check" && item.reason === "paused" ? <StandingCheckActions routineId={item.id} title={item.title} paused /> : null}
      </div>
    </li>
  );
}

/**
 * One responsibility as one full-width row, read left to right: what it is
 * and how automated (the level in words, the share with a meter, and the
 * counts); what already runs without the person (each automation with how it
 * starts and who runs it, and anything not running); and, taking the most
 * room, the manual tasks that could be automated with a suggestion and the
 * actions for each. Narrow panes stack the three parts.
 */
const AutomationRow = memo(function AutomationRow({
  responsibility,
  automation,
  dismissed,
  agentName,
  now,
  actions,
}: {
  responsibility: ResponsibilityWithRollup;
  automation: ResponsibilityAutomation | null;
  dismissed: ReadonlySet<string>;
  agentName: (id: string) => string | undefined;
  now: Date;
  actions: RowActions;
}) {
  const [expanded, setExpanded] = useState(false);
  const level = automation?.level ?? "manual";
  const share = automation?.share ?? null;
  const percent = responsibilityAutomationPercent(share);
  const shareLabel = automationShareLabel(share);
  const running = automation?.automations ?? [];
  const moreRunning = (automation?.automationCount ?? 0) - running.length;
  const stalled = automation?.stalledAutomations ?? [];
  const tasks = automation ? visibleCandidates(automation, dismissed) : { shown: [], others: [], unlisted: 0, more: 0 };
  const listed = expanded ? [...tasks.shown, ...tasks.others] : tasks.shown;
  const quiet = automation && listed.length === 0 ? noCandidatesWords(automation) : null;
  const path = responsibilityPath(responsibility.id);
  return (
    <li className="min-w-0" data-responsibility-id={responsibility.id} data-automation-level={level}>
      <div className="grid min-w-0 gap-4 rounded-lg border border-border bg-card px-4 py-3 @4xl:grid-cols-(--responsibility-automation-row-cols) @4xl:gap-6">
        <div className="flex min-w-0 flex-col gap-1.5" data-automation-identity="">
          <Link
            to={path}
            className="line-clamp-2 text-sm font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={responsibility.title}
          >
            {responsibility.title}
          </Link>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <LevelLabel level={level} />
            {shareLabel ? <span className="text-xs font-medium tabular-nums text-foreground" data-automation-share="">{shareLabel}</span> : null}
          </div>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true" data-automation-meter="">
            {/* Width is the measured share (data), not a visual value. */}
            {percent ? <div className="status-fill h-full rounded-full" style={{ ...levelStyle(level), width: `${percent}%` }} /> : null}
          </div>
          <p className="text-xs tabular-nums text-muted-foreground" data-automation-counts="">
            {automation ? automationCountsLine(automation) : "Not counted yet."}
          </p>
        </div>

        <section className="flex min-w-0 flex-col gap-2" aria-label="Runs without you" data-automation-running="">
          <h3 className="text-xs font-semibold text-muted-foreground">Runs without you</h3>
          {running.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {running.map((item) => <AutomationEntry key={item.id} item={item} agentName={agentName} now={now} />)}
              {moreRunning > 0 ? (
                <li className="pl-5.5 text-xs text-muted-foreground">
                  <Link to={path} className="hover:underline">and {moreRunning} more {moreRunning === 1 ? "automation" : "automations"}</Link>
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground" data-automation-none-running="">Nothing runs on its own yet.</p>
          )}
          {stalled.length > 0 ? (
            <ul className="flex flex-col gap-1.5" aria-label="Not running">
              {stalled.map((item) => <StalledEntry key={item.id} item={item} agentName={agentName} />)}
            </ul>
          ) : null}
        </section>

        {/* Its own container: a task's actions sit beside its text only when this
            column, not the page, is wide enough; otherwise they go underneath
            so the title and the suggestion keep the full width. */}
        <section className="@container flex min-w-0 flex-col gap-2" aria-label="Manual tasks that could be automated" data-automation-manual="">
          <h3 className="text-xs font-semibold text-muted-foreground">Manual tasks that could be automated</h3>
          {listed.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {listed.map((candidate) => (
                <CandidateRow
                  key={candidate.issueId}
                  candidate={candidate}
                  responsibilityId={responsibility.id}
                  agentName={agentName}
                  now={now}
                  actions={actions}
                />
              ))}
            </ul>
          ) : quiet ? (
            <p className="text-xs text-muted-foreground" data-automation-quiet="">{quiet}</p>
          ) : null}
          {tasks.more > 0 && !expanded ? (
            tasks.others.length > 0 ? (
              <Button type="button" variant="link" size="xs" className="h-auto self-start px-0 text-xs text-muted-foreground" onClick={() => setExpanded(true)} data-automation-more="">
                and {tasks.more} more manual {tasks.more === 1 ? "task" : "tasks"}
              </Button>
            ) : (
              <Link to={path} className="text-xs text-muted-foreground hover:underline" data-automation-more="">
                and {tasks.more} more manual {tasks.more === 1 ? "task" : "tasks"}
              </Link>
            )
          ) : null}
          {expanded && tasks.unlisted > 0 ? (
            <Link to={path} className="text-xs text-muted-foreground hover:underline" data-automation-more="">
              and {tasks.unlisted} more on the responsibility’s page
            </Link>
          ) : null}
        </section>
      </div>
    </li>
  );
});

function AutomationAreaSection({
  group,
  byId,
  dismissed,
  agentName,
  now,
  actions,
}: {
  group: AutomationAreaGroup;
  byId: ReadonlyMap<string, ResponsibilityAutomation>;
  dismissed: ReadonlySet<string>;
  agentName: (id: string) => string | undefined;
  now: Date;
  actions: RowActions;
}) {
  const areaKey = group.area?.id ?? "none";
  const headingId = `automation-area-${areaKey}`;
  return (
    <section aria-labelledby={headingId} data-board-area={areaKey} className="flex flex-col gap-3 border-t border-border pt-4">
      <BoardAreaHeader
        headingId={headingId}
        title={group.area?.title ?? "Not in an area"}
        archived={group.area?.status === "archived"}
        ownedLabel={group.ownedLabel}
        shareLabel={group.automationShare}
      />
      <ul className="flex flex-col gap-3">
        {group.items.map((item) => (
          <AutomationRow
            key={item.id}
            responsibility={item}
            automation={byId.get(item.id) ?? null}
            dismissed={dismissed}
            agentName={agentName}
            now={now}
            actions={actions}
          />
        ))}
      </ul>
    </section>
  );
}

function AutomationSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading how automated your responsibilities are">
      <Skeleton className="h-44 w-full rounded-xl" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-32 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/**
 * "Automation": how much of what the person owns runs without them, what
 * already runs, and the manual tasks that could be automated, each with an
 * instant suggestion and one button to talk it through with the responsible
 * agent. The overall picture first (its four counts filter the rows), then
 * the areas, each a header over one full-width row per responsibility, the
 * most manual first. Joins the automation read with the overview the page
 * already has. It shows how automated things are, never whether they meet
 * their bar.
 */
export function DashboardAutomation({ companyId, overview, agents, agentsById, now, onAddResponsibility, onReviewProposals }: DashboardViewProps) {
  const active = useMemo(() => activeResponsibilities(overview.responsibilities), [overview.responsibilities]);
  const query = useQuery({
    queryKey: queryKeys.responsibilities.automation(companyId),
    queryFn: () => responsibilitiesApi.automation(companyId),
    enabled: active.length > 0,
  });
  const [dismissed, dismiss] = useDismissedCandidates(companyId);
  const [making, setMaking] = useState<{ task: RoutineTaskTarget; filedUnder: string[] } | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const agentName = useCallback((id: string) => agentsById.get(id)?.name, [agentsById]);
  const read = query.data;

  const titles = useMemo(() => new Map(active.map((item) => [item.id, item.title])), [active]);
  const actions = useMemo<RowActions>(() => ({
    onSetUpByHand: (candidate, responsibilityId) => {
      // Every responsibility of the person's the task is under, this one first.
      const under = (read?.responsibilities ?? [])
        .filter((item) => item.manualTaskIds.includes(candidate.issueId))
        .map((item) => item.responsibilityId);
      const ids = [responsibilityId, ...under.filter((id) => id !== responsibilityId)];
      setMaking({
        task: {
          issueId: candidate.issueId,
          identifier: candidate.identifier,
          title: candidate.pendingOffer?.title ?? candidate.title,
          assigneeAgentId: candidate.pendingOffer?.agentId ?? candidate.responsibleAgentId ?? candidate.assigneeAgentId,
          suggestedCadence: candidate.suggestedCadence,
          cadenceSource: candidate.cadenceSource,
        },
        filedUnder: ids.map((id) => titles.get(id)).filter((title): title is string => !!title),
      });
    },
    onDismiss: (candidate) => dismiss(candidate.issueId),
    onMade: setMade,
  }), [dismiss, read, titles]);

  if (active.length === 0 && overview.proposed.length === 0) {
    return <ResponsibilitiesEmpty companyId={companyId} onAdd={() => onAddResponsibility(null)} />;
  }

  return (
    <div className="@container flex flex-col gap-6" data-dashboard-view="automation">
      <ProposalsNotice count={overview.proposed.length} onReview={onReviewProposals} />
      {made ? (
        <div role="status" className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-4 py-2" data-automation-made="">
          <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
            <Repeat aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {made}
          </p>
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => setMade(null)}>
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      {active.length > 0 ? (
        <QueryView query={query} action="load how automated your responsibilities are" loading={<AutomationSkeleton />}>
          {(loaded) => (
            <AutomationBody
              overview={overview}
              active={active}
              read={loaded}
              dismissed={dismissed}
              agentName={agentName}
              now={now}
              actions={actions}
            />
          )}
        </QueryView>
      ) : null}
      <MakeRoutineDialog
        open={making !== null}
        onOpenChange={(open) => {
          if (!open) setMaking(null);
        }}
        companyId={companyId}
        task={making?.task ?? null}
        agents={agents}
        filedUnder={making?.filedUnder ?? []}
        onCreated={(result) => setMade(`“${result.routine.title}” is automated now: ${result.cadenceLabel}.`)}
      />
    </div>
  );
}

function AutomationBody({
  overview,
  active,
  read,
  dismissed,
  agentName,
  now,
  actions,
}: {
  overview: DashboardViewProps["overview"];
  active: readonly ResponsibilityWithRollup[];
  read: ResponsibilityAutomationOverview;
  dismissed: ReadonlySet<string>;
  agentName: (id: string) => string | undefined;
  now: Date;
  actions: RowActions;
}) {
  const [filter, setFilter] = useState<ReadonlySet<ResponsibilityAutomationLevel>>(() => new Set());
  const groups = useMemo(
    () => automationAreaGroups(overview.areas, overview.responsibilities, read, filter),
    [overview.areas, overview.responsibilities, read, filter],
  );
  const counts = useMemo(() => automationLevelCounts(active, read), [active, read]);
  const byId = useMemo(() => automationById(read), [read]);
  const toggle = useCallback((level: ResponsibilityAutomationLevel) => {
    setFilter((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);
  return (
    <>
      <AutomationSummary counts={counts} read={read} dismissed={dismissed} filter={filter} onToggle={toggle} onClear={() => setFilter(new Set())} />
      {groups.length > 0 ? (
        <div className="flex flex-col gap-4" data-automation-rows="">
          {groups.map((group) => (
            <AutomationAreaSection
              key={group.area?.id ?? "__no_area__"}
              group={group}
              byId={byId}
              dismissed={dismissed}
              agentName={agentName}
              now={now}
              actions={actions}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
