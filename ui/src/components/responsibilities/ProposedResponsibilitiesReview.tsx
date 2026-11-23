import { useCallback, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  ResponsibilityArea,
  ResponsibilityOverview,
  ResponsibilityWithRollup,
  UpdateResponsibility,
} from "@paperclipai/shared";
import { responsibilityHasMetric } from "@paperclipai/shared";
import { Check, Pencil, Sparkles, X } from "lucide-react";
import { responsibilitiesApi } from "@/api/responsibilities";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { queryKeys } from "@/lib/queryKeys";
import {
  barDraftFrom,
  buildBarUpdate,
  describeMetricReading,
  groupByArea,
  isMetricDraftBlank,
  joinFieldLabels,
  missingBarFields,
  missingFieldsFromError,
  validateBarDraft,
  type BarDraft,
  type BarField,
} from "@/lib/responsibilities";
import { cn } from "@/lib/utils";
import { ResponsibilityBarFields } from "./ResponsibilityBarFields";

export interface ProposedResponsibilitiesReviewResult {
  /** Responsibilities the person confirmed in this action (now `active`), as the server saved them. */
  confirmed: ResponsibilityWithRollup[];
  /** Responsibilities the person dismissed in this action. */
  dismissed: ResponsibilityWithRollup[];
}

type AreaRef = Pick<ResponsibilityArea, "id" | "title" | "status">;

export interface ProposedResponsibilitiesReviewProps {
  companyId: string;
  /**
   * The proposals to review. Omit to read them (and their areas) from the
   * person's overview (shares the overview query cache).
   */
  proposed?: readonly ResponsibilityWithRollup[];
  /** Areas to group `proposed` by; read from the overview when `proposed` is omitted. */
  areas?: readonly AreaRef[];
  /** Whose overview to read when `proposed` is omitted; defaults to the acting user. */
  ownerUserId?: string | null;
  /**
   * Called after a confirm, adjust-and-confirm, dismiss or confirm-all
   * settles, with what that action changed. Not called when every request failed.
   */
  onReviewed?: (result: ProposedResponsibilitiesReviewResult) => void;
  heading?: string;
  description?: string;
  className?: string;
}

type RowAction = "confirm" | "dismiss" | "adjust";

interface Editing {
  id: string;
  title: string;
  draft: BarDraft;
  attempted: boolean;
  /** Fields the server said are missing (422). */
  serverMissing: BarField[];
}

type OverviewSnapshot = Array<[readonly unknown[], ResponsibilityOverview | undefined]>;

const EMPTY_PROPOSED: readonly ResponsibilityWithRollup[] = [];
const EMPTY_AREAS: readonly AreaRef[] = [];

/**
 * What a proposal still needs before it can be confirmed: nothing when it has
 * no metric at all (it is confirmed as not measured, and its bar is set later
 * on its page); the rest of the bar when its metric is half-filled.
 */
export function proposalMissing(proposal: Pick<ResponsibilityWithRollup, "standard" | "metricName" | "metricTarget">
  & Partial<Pick<ResponsibilityWithRollup, "metricKind" | "metricUnit" | "metricLow" | "metricHigh" | "metricCurrent">>): BarField[] {
  return missingBarFields(proposal);
}

/** The form shows no reading, so a blank metric is judged on what it shows: what is measured and its numbers. */
function metricLeftBlank(draft: BarDraft): boolean {
  return isMetricDraftBlank({ ...draft, metricCurrent: "" });
}

/**
 * The patch that confirms an adjusted proposal. A form whose metric is left
 * blank confirms it with no metric (clearing one it had); otherwise the whole
 * bar must be valid. Null while the form is not ready to save.
 */
function adjustedPatch(item: ResponsibilityWithRollup, editing: Editing): UpdateResponsibility | null {
  const title = editing.title.trim();
  if (!title) return null;
  if (metricLeftBlank(editing.draft)) {
    const clearMetric = responsibilityHasMetric(item)
      ? { metricName: null, metricUnit: null, metricTarget: null, metricLow: null, metricHigh: null, metricCurrent: null }
      : {};
    return { title, standard: editing.draft.standard.trim() || null, ...clearMetric, status: "active" };
  }
  const checked = validateBarDraft(editing.draft);
  return checked.ok ? { title, ...buildBarUpdate(checked.value), status: "active" } : null;
}

/** Move reviewed proposals in every cached overview for the company (optimistic). */
function applyReviewToOverviews(
  queryClient: QueryClient,
  companyId: string,
  changes: ReadonlyMap<string, { status: "active" | "dismissed"; patch: Partial<ResponsibilityWithRollup> }>,
): OverviewSnapshot {
  const key = queryKeys.responsibilities.overviews(companyId);
  const snapshot = queryClient.getQueriesData<ResponsibilityOverview>({ queryKey: key }) as OverviewSnapshot;
  queryClient.setQueriesData<ResponsibilityOverview>({ queryKey: key }, (old) => {
    if (!old) return old;
    const confirmed: ResponsibilityWithRollup[] = [];
    const proposed = old.proposed.filter((item) => {
      const change = changes.get(item.id);
      if (!change) return true;
      if (change.status === "active") {
        confirmed.push({ ...item, ...change.patch, status: "active", confirmedAt: new Date() });
      }
      return false;
    });
    if (proposed.length === old.proposed.length) return old;
    const byHealth = { ...old.totals.byHealth };
    for (const item of confirmed) byHealth[item.rollup.health] += 1;
    return {
      ...old,
      proposed,
      responsibilities: [...old.responsibilities, ...confirmed],
      totals: { ...old.totals, byHealth },
    };
  });
  return snapshot;
}

function restoreOverviews(queryClient: QueryClient, snapshot: OverviewSnapshot) {
  for (const [key, data] of snapshot) queryClient.setQueryData(key, data);
}

/** The adjust form: the name and the bar, then Cancel / Save and confirm in one footer. */
function AdjustForm({
  proposal,
  editing,
  onChange,
  onCancel,
  onSubmit,
}: {
  proposal: ResponsibilityWithRollup;
  editing: Editing;
  onChange: (next: Editing) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  // A blank metric is allowed: the proposal is confirmed as not measured.
  const blankMetric = metricLeftBlank(editing.draft);
  const checked = validateBarDraft(editing.draft);
  const showProblems = editing.attempted && !blankMetric && !checked.ok;
  const missing = new Set<BarField>([
    ...(showProblems && !checked.ok ? checked.missing : []),
    ...editing.serverMissing,
  ]);
  const invalid = new Set<BarField>(showProblems && !checked.ok ? checked.invalid : []);
  const titleMissing = editing.attempted && !editing.title.trim();
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-label={`Adjust ${proposal.title}`}>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">What you own</span>
        <Input
          autoFocus
          value={editing.title}
          maxLength={200}
          aria-invalid={titleMissing || undefined}
          onChange={(event) => onChange({ ...editing, title: event.target.value })}
        />
        {titleMissing ? <span className="text-xs text-destructive">Name what you own</span> : null}
      </label>
      <ResponsibilityBarFields
        draft={editing.draft}
        onChange={(draft) => onChange({ ...editing, draft })}
        missing={missing}
        invalid={invalid}
        problems={showProblems && !checked.ok ? checked.problems : undefined}
      />
      {blankMetric && editing.serverMissing.length === 0 ? (
        <p className="text-xs text-muted-foreground">You can leave what you measure blank and set it up later.</p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Save and confirm
        </Button>
      </div>
    </form>
  );
}

/** A proposal as it reads before any decision: its bar, its number and target, and why. */
function ProposalSummary({ proposal }: { proposal: ResponsibilityWithRollup }) {
  const metric = proposal.rollup.metric;
  const missing = proposalMissing(proposal);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h4 className="text-sm font-semibold text-foreground">{proposal.title}</h4>
      {proposal.standard ? <p className="text-sm text-foreground">{proposal.standard}</p> : null}
      {metric ? (
        <p className="text-sm tabular-nums text-muted-foreground">{describeMetricReading(metric).summary}</p>
      ) : null}
      {missing.length > 0 ? (
        <p className="text-xs text-muted-foreground">Needs {joinFieldLabels(missing)} before you can confirm it.</p>
      ) : null}
      {proposal.evidence ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Why: </span>
          {proposal.evidence}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Review the responsibilities an agent (the onboarding guide) proposed,
 * grouped by area: confirm each as it is, adjust its name, bar, metric,
 * target or direction and confirm, or dismiss it. Confirming one also makes
 * its area active on the server. Self-contained, so it mounts on the
 * Responsibilities page and inside the onboarding chat.
 *
 * A proposal with no metric at all confirms as it is and reads as not
 * measured until its bar is set; one with a half-filled metric opens the
 * adjust form, which may finish the bar or leave the metric blank.
 *
 * Changes apply optimistically: a reviewed proposal leaves the list at once
 * and returns, with the error beside it, if the server refuses. A refusal for
 * missing fields (422) opens the adjust form with those fields marked.
 */
export function ProposedResponsibilitiesReview({
  companyId,
  proposed: proposedProp,
  areas: areasProp,
  ownerUserId,
  onReviewed,
  heading = "Proposed for you",
  description = "Your guide drafted these from what it learned. Confirm each one you own as it is, adjust its bar or numbers, or dismiss it.",
  className,
}: ProposedResponsibilitiesReviewProps) {
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey: queryKeys.responsibilities.overview(companyId, { ownerUserId }),
    queryFn: () => responsibilitiesApi.overview(companyId, { ownerUserId }),
    enabled: proposedProp === undefined && !!companyId,
  });
  const source = proposedProp ?? overview.data?.proposed ?? EMPTY_PROPOSED;
  const areas = areasProp ?? overview.data?.areas ?? EMPTY_AREAS;

  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<Readonly<Record<string, RowAction>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const visible = useMemo(() => source.filter((item) => !hidden.has(item.id)), [source, hidden]);
  const groups = useMemo(() => groupByArea(areas, visible), [areas, visible]);
  const complete = useMemo(() => visible.filter((item) => proposalMissing(item).length === 0), [visible]);

  const startEditing = useCallback((item: ResponsibilityWithRollup, serverMissing: BarField[] = []) => {
    setEditing({ id: item.id, title: item.title, draft: barDraftFrom(item), attempted: serverMissing.length > 0, serverMissing });
  }, []);

  const run = useCallback(
    async (
      items: ResponsibilityWithRollup[],
      action: RowAction,
      patchFor: (item: ResponsibilityWithRollup) => UpdateResponsibility,
    ) => {
      if (items.length === 0) return;
      const ids = items.map((item) => item.id);
      const nextStatus = action === "dismiss" ? "dismissed" : "active";
      setHidden((current) => new Set([...current, ...ids]));
      setBusy((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, action])) }));
      setErrors((current) => {
        const next = { ...current };
        for (const id of ids) delete next[id];
        return next;
      });
      const changes = new Map(
        items.map((item) => {
          const { status: _status, ...rest } = patchFor(item);
          return [item.id, { status: nextStatus, patch: rest as Partial<ResponsibilityWithRollup> }] as const;
        }),
      );
      const snapshot = applyReviewToOverviews(queryClient, companyId, changes);

      const results = await Promise.allSettled(items.map((item) => responsibilitiesApi.update(item.id, patchFor(item))));
      const succeeded: ResponsibilityWithRollup[] = [];
      const failed = new Map<string, string>();
      let reopen: { item: ResponsibilityWithRollup; missing: BarField[] } | null = null;
      results.forEach((result, index) => {
        const item = items[index]!;
        if (result.status === "fulfilled") {
          succeeded.push(result.value);
          return;
        }
        const missing = missingFieldsFromError(result.reason);
        if (missing.length > 0) {
          failed.set(item.id, `Add ${joinFieldLabels(missing)} to confirm it.`);
          reopen ??= { item, missing };
        } else {
          failed.set(item.id, `Couldn’t save your answer for “${item.title}”. ${describeError(result.reason).body}`);
        }
      });

      if (failed.size > 0) {
        // Put every cached overview back, then re-apply only what the server accepted.
        restoreOverviews(queryClient, snapshot);
        const accepted = new Map([...changes].filter(([id]) => !failed.has(id)));
        if (accepted.size > 0) applyReviewToOverviews(queryClient, companyId, accepted);
        setHidden((current) => new Set([...current].filter((id) => !failed.has(id))));
        setErrors((current) => ({ ...current, ...Object.fromEntries(failed) }));
        if (reopen) {
          const { item, missing } = reopen as { item: ResponsibilityWithRollup; missing: BarField[] };
          startEditing(item, missing);
        }
      }
      setBusy((current) => {
        const next = { ...current };
        for (const id of ids) delete next[id];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all });

      if (succeeded.length > 0) {
        onReviewed?.({
          confirmed: nextStatus === "active" ? succeeded : [],
          dismissed: nextStatus === "dismissed" ? succeeded : [],
        });
      }
    },
    [companyId, onReviewed, queryClient, startEditing],
  );

  const confirm = (item: ResponsibilityWithRollup) => {
    const missing = proposalMissing(item);
    // Ask for what is missing here rather than send a request the server refuses.
    if (missing.length > 0) {
      startEditing(item, missing);
      return;
    }
    void run([item], "confirm", () => ({ status: "active" }));
  };
  const dismiss = (item: ResponsibilityWithRollup) => run([item], "dismiss", () => ({ status: "dismissed" }));
  const confirmAll = async () => {
    setConfirmingAll(true);
    try {
      await run(complete, "confirm", () => ({ status: "active" }));
    } finally {
      setConfirmingAll(false);
    }
  };
  const saveAdjusted = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const item = source.find((candidate) => candidate.id === editing.id);
    if (!item) return;
    const patch = adjustedPatch(item, editing);
    if (!patch) {
      setEditing({ ...editing, attempted: true });
      return;
    }
    setEditing(null);
    await run([item], "adjust", () => patch);
  };

  if (proposedProp === undefined && overview.isPending) return null;
  // Rows that failed stay visible with their error, so an empty list means nothing is left to review.
  if (visible.length === 0) return null;

  return (
    <section aria-labelledby="proposed-responsibilities-heading" className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="proposed-responsibilities-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />
            {heading}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {complete.length > 1 ? (
          <Button size="sm" onClick={() => void confirmAll()} disabled={confirmingAll}>
            <Check aria-hidden="true" />
            {confirmingAll ? "Confirming…" : `Confirm all ${complete.length}`}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.area?.id ?? "__no_area__"} className="flex flex-col gap-2" data-area-group={group.area?.id ?? "none"}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.area ? group.area.title : "No area"}
            </h3>
            <Card elevation="low" className="gap-0 py-1">
              <ul className="flex flex-col">
                {group.items.map((item) => {
                  const rowBusy = busy[item.id];
                  const error = errors[item.id];
                  const isEditing = editing?.id === item.id;
                  return (
                    <li
                      key={item.id}
                      data-proposal-id={item.id}
                      className="flex flex-col gap-3 border-b border-border px-5 py-4 last:border-b-0"
                      aria-busy={rowBusy ? true : undefined}
                    >
                      {isEditing ? (
                        <AdjustForm
                          proposal={item}
                          editing={editing}
                          onChange={setEditing}
                          onCancel={() => setEditing(null)}
                          onSubmit={(event) => void saveAdjusted(event)}
                        />
                      ) : (
                        <>
                          <ProposalSummary proposal={item} />
                          <div className="flex flex-wrap items-center gap-2">
                            <Button size="sm" onClick={() => confirm(item)} disabled={!!rowBusy || confirmingAll}>
                              <Check aria-hidden="true" />
                              Confirm
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => startEditing(item)} disabled={!!rowBusy || confirmingAll}>
                              <Pencil aria-hidden="true" />
                              Adjust
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => void dismiss(item)} disabled={!!rowBusy || confirmingAll}>
                              <X aria-hidden="true" />
                              Dismiss
                            </Button>
                          </div>
                        </>
                      )}
                      {error ? (
                        <p role="alert" className="text-sm text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        ))}
      </div>
    </section>
  );
}
