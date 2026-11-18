import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AutomationCandidate } from "@paperclipai/shared";
import { ArrowUpRight, CircleAlert, MessagesSquare, Pencil, Repeat, Wrench } from "lucide-react";
import { responsibilitiesApi } from "@/api/responsibilities";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { queryKeys } from "@/lib/queryKeys";
import { describeError } from "@/api/errors";
import { useOpenAutomationConversation } from "@/hooks/useOpenAutomationConversation";
import { automationShareLabel, automationSplitWords, conversationButtonLabel } from "@/lib/responsibility-automation";
import { capList, workBearings, type BearingItem, type WorkBearing, type WorkItemKind } from "@/lib/responsibility-views";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { MakeRoutineDialog, type RoutineTaskTarget } from "./MakeRoutineDialog";
import { MetricGlance } from "./MetricGlance";
import { ResponsibilityMetrics } from "./ResponsibilityMetricSet";
import { NarrativeParagraph, useResponsibilitySummary } from "./ResponsibilityNarrative";
import { BarConversationStatus } from "./ResponsibilityBarCard";
import { ResponsibilityStatusBlock } from "./ResponsibilityStatusLead";
import {
  ArtifactCards,
  ProposalsNotice,
  ResponsibilityHeaderActions,
  ResponsibilityViewHeader,
  SkillCards,
  WorkKind,
} from "./ResponsibilityViewParts";
import type { ResponsibilityViewProps } from "./view-props";

const CAP: Record<WorkItemKind, number> = { project: 3, task: 4, routine: 3 };
const TITLE: Record<WorkItemKind, string> = { project: "Projects", task: "Tasks", routine: "Routines" };
const EMPTY: Record<WorkItemKind, string> = {
  project: "No open projects.",
  task: "No open tasks.",
  routine: "No routines.",
};

/** Words for screen readers before the reason; the icon and the reason say it on screen. */
const BEARING_PREFIX: Record<WorkBearing, string> = {
  holding: "Holding the number back: ",
  moving: "Moving the number: ",
  neutral: "",
};
const BEARING_TEXT: Record<WorkBearing, string> = {
  holding: "text-(--status-task-icon-blocked)",
  moving: "text-(--status-task-icon-done)",
  neutral: "text-muted-foreground",
};

function BearingIcon({ bearing }: { bearing: WorkBearing }) {
  if (bearing === "holding") return <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />;
  if (bearing === "moving") return <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />;
  return null;
}

/** The two quiet actions on a manual task: talk it through with the agent (first), or set it up by hand. */
interface AutomateActions {
  /** "Automate with Analyst", "Continue with Analyst", "Review Analyst's proposal". */
  label: string;
  onTalk: () => void;
  onByHand: () => void;
  busy: boolean;
}

/**
 * One project, task or routine with how it bears on the number beneath its
 * name. Opens its page. A manual task carries two quiet buttons at its right
 * (`automate`): automate it with the agent, or set it up by hand.
 */
function BearingRow({ entry, automate }: { entry: BearingItem; automate?: AutomateActions }) {
  const { item, bearing, reason } = entry;
  const onMakeRoutine = automate?.onByHand;
  return (
    <li
      data-work-kind={item.kind}
      data-work-id={item.id}
      data-bearing={bearing}
      data-finished={entry.finished ? "true" : undefined}
      className={onMakeRoutine ? "relative" : undefined}
    >
      <Link
        to={item.href}
        className={cn(
          "flex min-w-0 items-start gap-3 px-4 py-2 text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          onMakeRoutine && "pr-18",
        )}
      >
        <span className="mt-0.5">
          <WorkKind item={item} showLabel={false} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            {item.kind === "task" && item.task.identifier ? (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.task.identifier}</span>
            ) : null}
            <span className={cn("line-clamp-1 text-foreground", entry.finished && "text-muted-foreground")} title={item.title}>
              {item.title}
            </span>
          </span>
          <span className={cn("flex min-w-0 items-center gap-1 text-xs", BEARING_TEXT[bearing])} data-bearing-reason="">
            <BearingIcon bearing={bearing} />
            <span className="line-clamp-1" title={reason}>
              <span className="sr-only">{BEARING_PREFIX[bearing]}</span>
              {reason}
            </span>
          </span>
        </span>
      </Link>
      {automate ? (
        <span className="absolute right-3 top-2 flex items-center gap-0.5">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={automate.busy}
            aria-label={`${automate.label}: “${item.title}”`}
            title={automate.label}
            onClick={automate.onTalk}
            data-automate-with-agent=""
          >
            <MessagesSquare aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            aria-label={`Set up “${item.title}” by hand`}
            title="Set it up by hand"
            onClick={automate.onByHand}
            data-make-routine=""
          >
            <Wrench aria-hidden="true" />
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/** One kind of work, capped, what holds the number back first, with "and N more". */
function CappedList({
  kind,
  items,
  total,
  automateFor,
}: {
  kind: WorkItemKind;
  items: readonly BearingItem[];
  total: number;
  /** For a manual task that could be automated, how; undefined for every other row. */
  automateFor?: (entry: BearingItem) => AutomateActions | undefined;
}) {
  const { shown } = capList(items, CAP[kind]);
  const more = Math.max(0, total - shown.length);
  const headingId = `one-screen-${kind}-heading`;
  return (
    <section aria-labelledby={headingId} data-work-list={kind}>
      <Card elevation="low" className="gap-0 overflow-hidden py-0">
        <h2 id={headingId} className="flex items-baseline gap-2 border-b border-border px-4 py-2 text-sm font-semibold text-foreground">
          {TITLE[kind]} <span className="text-xs font-normal tabular-nums text-muted-foreground">{total}</span>
        </h2>
        {shown.length > 0 ? (
          <ul className="flex flex-col">
            {shown.map((entry) => (
              <BearingRow key={entry.item.id} entry={entry} automate={automateFor?.(entry)} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-2 text-sm text-muted-foreground">{EMPTY[kind]}</p>
        )}
        {more > 0 ? <p className="border-t border-border px-4 py-1.5 text-xs text-muted-foreground">and {more} more</p> : null}
      </Card>
    </section>
  );
}

/** The key to the marks on the rows, in words. */
function BearingKey() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-bearing-key="">
      <span className={cn("flex items-center gap-1", BEARING_TEXT.holding)}>
        <BearingIcon bearing="holding" />
        Holding the number back
      </span>
      <span className={cn("flex items-center gap-1", BEARING_TEXT.moving)}>
        <BearingIcon bearing="moving" />
        Moving it
      </span>
    </p>
  );
}

/**
 * "One screen": everything essential without scrolling on a laptop. The bar
 * on one side: its sentence, its status (the agent's written status leading
 * when there is one), up to three metrics drawn in their forms, and a
 * paragraph on what in the work is affecting the number. The work on the
 * other, in this order: routines and skills first, then projects and tasks,
 * then artifacts; routines, projects and tasks as short capped lists with
 * each item marked with how it bears on the number, skills and artifacts as
 * small cards (one column on narrow screens). The header carries the full
 * page's actions, and the bar its "Edit the bar".
 */
export function ResponsibilityOneScreen({
  responsibility,
  companyId,
  agents,
  agentsById,
  now,
  notices,
  actions,
  onReviewProposal,
  onEditBar,
}: ResponsibilityViewProps) {
  const { rollup } = responsibility;
  // How automated it is, from the owner's automation read (active responsibilities only).
  const automationQuery = useQuery({
    queryKey: queryKeys.responsibilities.automation(companyId, responsibility.ownerUserId),
    queryFn: () => responsibilitiesApi.automation(companyId, { ownerUserId: responsibility.ownerUserId }),
    enabled: !!companyId && responsibility.status === "active",
  });
  const automation = automationQuery.data?.responsibilities.find((item) => item.responsibilityId === responsibility.id) ?? null;
  const [making, setMaking] = useState<RoutineTaskTarget | null>(null);
  const agentName = useCallback((id: string) => agentsById.get(id)?.name, [agentsById]);
  const conversation = useOpenAutomationConversation();
  const openConversation = conversation.open;
  const automateFor = useCallback((entry: BearingItem): AutomateActions | undefined => {
    if (entry.item.kind !== "task" || !automation?.manualTaskIds.includes(entry.item.id)) return undefined;
    const { task } = entry.item;
    const candidate: AutomationCandidate | undefined = automation.candidates.find((item) => item.issueId === task.id);
    // Beyond the read's ranked few, the server picks the responsible agent.
    const agentId = candidate?.responsibleAgentId ?? task.assigneeAgentId ?? null;
    return {
      label: conversationButtonLabel({ conversation: candidate?.conversation ?? null, responsibleAgentId: agentId }, agentName),
      busy: conversation.isPending,
      onTalk: () => openConversation({ issueId: task.id, agentId, responsibilityId: responsibility.id, conversation: candidate?.conversation ?? null }),
      onByHand: () => setMaking({
        issueId: task.id,
        identifier: task.identifier,
        title: candidate?.pendingOffer?.title ?? task.title,
        assigneeAgentId: candidate?.pendingOffer?.agentId ?? agentId,
        suggestedCadence: candidate?.suggestedCadence ?? null,
        cadenceSource: candidate?.cadenceSource,
      }),
    };
  }, [automation, agentName, conversation.isPending, openConversation, responsibility.id]);
  const byKind = useMemo(() => {
    const entries = workBearings(responsibility, now, agentName);
    return {
      project: entries.filter((entry) => entry.item.kind === "project"),
      task: entries.filter((entry) => entry.item.kind === "task"),
      routine: entries.filter((entry) => entry.item.kind === "routine"),
    };
  }, [responsibility, now, agentName]);
  const narrative = useResponsibilitySummary(responsibility.id);
  const standard = responsibility.standard?.trim();
  const openTasksListed = byKind.task.filter((entry) => !entry.finished).length;
  const finishedTasksListed = byKind.task.length - openTasksListed;
  const marked = [...byKind.project, ...byKind.task, ...byKind.routine].some((entry) => entry.bearing !== "neutral");
  const canEditBar = onEditBar && responsibility.status !== "dismissed";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5" data-responsibility-view="one_screen">
      <ResponsibilityViewHeader
        responsibility={responsibility}
        actions={<ResponsibilityHeaderActions status={responsibility.status} actions={actions} />}
      >
        {notices}
      </ResponsibilityViewHeader>
      {responsibility.status === "proposed" ? <ProposalsNotice count={1} subject="this" onReview={onReviewProposal} /> : null}
      {/* A bar an agent proposed in conversation is acceptable here, without leaving this view. */}
      <BarConversationStatus responsibility={responsibility} agentsById={agentsById} />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card id="responsibility-bar-summary" elevation="low" className="h-fit gap-5 px-5 py-5 lg:col-span-2" aria-labelledby="one-screen-bar-heading">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <h2 id="one-screen-bar-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">The bar</h2>
              {canEditBar ? (
                <Button size="xs" variant="ghost" onClick={onEditBar}>
                  <Pencil aria-hidden="true" />
                  Edit the bar
                </Button>
              ) : null}
            </div>
            <p className="text-sm text-foreground">
              {standard || <span className="text-muted-foreground">No bar yet.</span>}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <ResponsibilityStatusBlock responsibility={responsibility} agentsById={agentsById} now={now} editable={!!canEditBar} />
            {automation ? (
              <p className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground" data-automation-line="">
                <Repeat aria-hidden="true" className="size-3.5 shrink-0" />
                {automationSplitWords(automation.automationCount, automation.manualTaskCount)}
                {automationShareLabel(automation.share) ? ` · ${automationShareLabel(automation.share)}` : null}
              </p>
            ) : null}
          </div>
          <div className="border-t border-border pt-4" data-bar-metrics="">
            <ResponsibilityMetrics
              responsibilityId={responsibility.id}
              primary={rollup.metric}
              now={now}
              agentsById={agentsById}
              layout="stack"
              editable={!!canEditBar}
              fallback={<MetricGlance metric={rollup.metric} health={rollup.health} now={now} size="hero" />}
            />
          </div>
          {narrative.summary?.text.trim() ? (
            <section aria-labelledby="one-screen-affecting-heading" className="flex flex-col gap-1.5 border-t border-border pt-4" data-affecting-summary="">
              <h3 id="one-screen-affecting-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                What is affecting the number
              </h3>
              <NarrativeParagraph summary={narrative.summary} stillWaiting={narrative.stillWaiting} />
            </section>
          ) : null}
        </Card>

        <div className="flex min-w-0 flex-col gap-4 lg:col-span-3" data-work-order="">
          {marked ? <BearingKey /> : null}
          <CappedList kind="routine" items={byKind.routine} total={byKind.routine.length} />
          <SkillCards skills={responsibility.skills} agentsById={agentsById} />
          <CappedList kind="project" items={byKind.project} total={byKind.project.length} />
          <CappedList
            kind="task"
            items={byKind.task}
            total={Math.max(rollup.openTasks, openTasksListed) + finishedTasksListed}
            automateFor={automateFor}
          />
          {conversation.error ? (
            <p role="alert" className="text-xs text-destructive">Couldn’t open the conversation. {describeError(conversation.error).body}</p>
          ) : null}
          <ArtifactCards artifacts={responsibility.artifacts} total={responsibility.artifactsTotal} />
        </div>
      </div>

      <MakeRoutineDialog
        open={making !== null}
        onOpenChange={(open) => {
          if (!open) setMaking(null);
        }}
        companyId={companyId}
        task={making}
        agents={agents}
        filedUnder={[responsibility.title]}
      />
    </div>
  );
}
