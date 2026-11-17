import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { decisionEffectTargetIssueIds, type Agent, type AttentionSubject, type DecisionEffect } from "@paperclipai/shared";
import { decisionsApi, type DecisionOutcome } from "../api/decisions";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { DecisionCard, type DecisionIssueRef } from "./DecisionCard";
import { DecisionCardFooter } from "./DecisionCardFooter";
import { MarkdownBody } from "./MarkdownBody";
import { NeedsYouPanel, NeedsYouPanelNote } from "./coordinator/NeedsYouCardKit";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

interface DecisionResolverProps {
  companyId: string;
  decisionId: string;
  /** Origin issue subject from the attention row (already carries identifier/href). */
  originIssue?: AttentionSubject | null;
  agentMap?: Map<string, Agent>;
  /** Complete terminal list item used to avoid one detail request per history row. */
  initialDecision?: DecisionOutcome;
  /** Fresh, authorized terminal record owned by an enclosing detail query. */
  recordedDecision?: DecisionOutcome;
  /** Called after a decide so the parent can refresh the feed row. */
  onResolved?: () => void;
  /** A Needs You card's task link (PAP-775). Passing it renders the compact
   * card: the options in an inset panel, the task link and Submit below. */
  leading?: ReactNode;
}

type IssueDetail = Awaited<ReturnType<typeof issuesApi.get>>;

// A module-level combine function lets TanStack Query structurally share this
// projection until issue data actually changes. Depending on useQueries' raw
// result array would invalidate resolveIssue on every render.
function combineIssueData(results: Array<{ data?: IssueDetail }>) {
  return results.map((result) => result.data);
}

export function signedCancelTreePreviewIds(targetIssueId: string, snapshot: { descendantIds?: string[] } | undefined) {
  return snapshot?.descendantIds ? [targetIssueId, ...snapshot.descendantIds] : null;
}

/**
 * Container for a Decisions-v1 decision surfaced in the attention feed. Fetches
 * the full decision (`get`) plus the shared open-list (for `targetChanged`),
 * resolves referenced issue ids + the cancel-tree preview, owns the decide
 * mutation, and invalidates the attention feed + target-issue keys on
 * success — same conventions as {@link AttentionInteractionResolver}.
 */
function issueLabel(ref: DecisionIssueRef | null, id: string) {
  return ref?.identifier ?? ref?.title ?? `issue ${id.slice(0, 8)}`;
}

/** What choosing an option does, in one line (mirrors the full card's preview). */
function effectLine(effect: DecisionEffect, resolve: (id: string) => DecisionIssueRef | null) {
  const target = issueLabel(resolve(effect.targetIssueId), effect.targetIssueId);
  switch (effect.type) {
    case "comment_on_issue": return `Comment on ${target}`;
    case "create_issue": return `Create “${effect.draft.title}”`;
    case "update_issue_status": return `Set ${target} to ${effect.status.replaceAll("_", " ")}`;
    case "assign_issue": return `Reassign ${target}`;
    case "resolve_blocker": return `Unblock ${target}`;
    case "cancel_issue_tree": return `Cancel ${target} and its sub-tree`;
    default: return "Apply effect";
  }
}

/**
 * Paper "Make a choice" (PAP-775): the ask, its options as a radio list in the
 * inset panel, and one Submit on the right of the footer. A decision that can
 * cancel an issue tree keeps the full card and its typed confirmation.
 */
function CompactDecision({ decision, resolveIssue, targetChanged, busy, errorMessage, leading, onDecide }: {
  decision: DecisionOutcome;
  resolveIssue: (id: string) => DecisionIssueRef | null;
  targetChanged: Record<string, boolean> | null;
  busy: boolean;
  errorMessage: string | null;
  leading: ReactNode;
  onDecide: (optionId: string, inputValues: Record<string, string>) => void;
}) {
  const [optionId, setOptionId] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const stale = new Set(Object.entries(targetChanged ?? {}).filter(([, changed]) => changed).map(([id]) => id));
  const requiredUnmet = (decision.inputs ?? []).some((field) => field.required && !(inputValues[field.id] ?? "").trim());
  const blocked = (id: string | null) => decision.options.find((option) => option.id === id)?.effects
    .some((effect) => effect.staleness === "strict" && decisionEffectTargetIssueIds(effect).some((target) => stale.has(target))) ?? false;
  const body = decision.body?.trim();
  return (
    <div className="space-y-4" data-decision-state="pending">
      <div className="space-y-3">
        <h2 data-decision-prompt className="text-base font-medium">{decision.title}</h2>
        {body ? <div className="text-sm text-muted-foreground"><MarkdownBody className="paperclip-markdown-on-accent">{body}</MarkdownBody></div> : null}
      </div>
      <NeedsYouPanel>
        {(decision.inputs ?? []).map((field) => (
          <label key={field.id} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{field.label}{field.required ? " · Required" : ""}</span>
            <Textarea
              value={inputValues[field.id] ?? ""}
              onChange={(event) => setInputValues((current) => ({ ...current, [field.id]: event.target.value }))}
              placeholder={field.placeholder ?? undefined}
              maxLength={field.maxLength ?? undefined}
              className="min-h-16 bg-card text-sm"
            />
          </label>
        ))}
        <div role="radiogroup" aria-label="Options" className="flex flex-col">
          {decision.options.map((option) => {
            const selected = optionId === option.id;
            const disabled = busy || blocked(option.id);
            const effects = option.effects.map((effect) => effectLine(effect, resolveIssue));
            return (
              <button key={option.id} type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={() => setOptionId(option.id)}
                className={cn("flex w-full items-start gap-2.5 rounded-sm px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                  selected ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                <span aria-hidden className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-foreground" : "border-muted-foreground/50")}>
                  {selected ? <span className="size-2 rounded-full bg-foreground" /> : null}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-(length:--text-compact) leading-5">{option.label}{blocked(option.id) ? " · Target changed" : ""}</span>
                  {option.description ? <span className="text-xs leading-4.5 text-muted-foreground">{option.description}</span> : null}
                  {effects.length > 0 ? <span className="text-xs leading-4.5 text-muted-foreground">{effects.join(" · ")}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
        {stale.size > 0 ? <NeedsYouPanelNote>A target changed since this was proposed, so options that need it unchanged are off.</NeedsYouPanelNote> : null}
      </NeedsYouPanel>
      {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
      <DecisionCardFooter leading={leading}>
        <Button size="sm" disabled={!optionId || busy || requiredUnmet || blocked(optionId)} onClick={() => { if (optionId) onDecide(optionId, inputValues); }}>
          {busy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Submitting…</> : "Submit choice"}
        </Button>
      </DecisionCardFooter>
    </div>
  );
}

export function DecisionResolver({ companyId, decisionId, originIssue, agentMap, initialDecision, recordedDecision, onResolved, leading }: DecisionResolverProps) {
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const prefix = selectedCompany?.issuePrefix ?? "";
  const issueHref = useCallback(
    (idOrIdentifier: string) => (prefix ? `/${prefix}/issues/${idOrIdentifier}` : `/issues/${idOrIdentifier}`),
    [prefix],
  );

  const detail = useQuery({
    queryKey: queryKeys.decisions.detail(decisionId),
    queryFn: () => decisionsApi.get(decisionId),
    enabled: !!decisionId && !recordedDecision,
    initialData: initialDecision,
    staleTime: 30_000,
  });
  const decision = recordedDecision ?? detail.data;

  // Shared across every open decision row → a single fetch carries `targetChanged`.
  const openList = useQuery({
    queryKey: queryKeys.decisions.list(companyId, "open"),
    queryFn: () => decisionsApi.list(companyId, { status: "open" }),
    enabled: !!companyId && decision?.status === "open",
  });
  const targetChanged = useMemo(
    () => openList.data?.find((entry) => entry.id === decisionId)?.targetChanged ?? null,
    [openList.data, decisionId],
  );

  // Issue ids referenced by snapshots / effects / results, resolved to labels.
  const referencedIds = useMemo(() => {
    if (!decision) return [] as string[];
    const ids = new Set<string>(Object.keys(decision.targetSnapshots ?? {}));
    for (const snapshot of Object.values(decision.targetSnapshots ?? {})) {
      for (const descendantId of snapshot.descendantIds ?? []) ids.add(descendantId);
    }
    for (const option of decision.options) {
      for (const effect of option.effects) {
        for (const id of decisionEffectTargetIssueIds(effect)) ids.add(id);
      }
    }
    for (const execution of decision.executions ?? []) {
      ids.add(execution.targetIssueId);
      const created = (execution.result ?? {}).issueId;
      if (typeof created === "string") ids.add(created);
    }
    if (originIssue?.id) ids.delete(originIssue.id);
    return [...ids];
  }, [decision, originIssue?.id]);

  const issueData = useQueries({
    queries: referencedIds.map((id) => ({
      queryKey: queryKeys.issues.detail(id),
      queryFn: () => issuesApi.get(id),
      staleTime: 30_000,
    })),
    combine: combineIssueData,
  });

  const resolveIssue = useMemo(() => {
    const map = new Map<string, DecisionIssueRef>();
    if (originIssue?.id) {
      map.set(originIssue.id, {
        id: originIssue.id,
        identifier: originIssue.identifier,
        title: originIssue.title,
        href: originIssue.href ?? issueHref(originIssue.identifier ?? originIssue.id),
        status: originIssue.status,
      });
    }
    issueData.forEach((issue, index) => {
      const id = referencedIds[index];
      if (issue && id) {
        map.set(id, {
          id,
          identifier: issue.identifier ?? null,
          title: issue.title ?? null,
          href: issueHref(issue.identifier ?? id),
          status: issue.status ?? null,
        });
      }
    });
    return (id: string) => map.get(id) ?? null;
  }, [originIssue, referencedIds, issueData, issueHref]);

  const cancelTreePreview = useCallback((targetIssueId: string): DecisionIssueRef[] | null => {
    const snapshot = decision?.targetSnapshots?.[targetIssueId];
    const signedIds = signedCancelTreePreviewIds(targetIssueId, snapshot);
    if (!signedIds) return null;
    const refs = signedIds.map(resolveIssue);
    return refs.every((ref): ref is DecisionIssueRef => ref !== null) ? refs : null;
  }, [decision?.targetSnapshots, resolveIssue]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.decisions.detail(decisionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.decisions.list(companyId, "open") });
    queryClient.invalidateQueries({ queryKey: queryKeys.decisions.list(companyId, "decided") });
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    for (const id of Object.keys(decision?.targetSnapshots ?? {})) {
      queryClient.invalidateQueries({ queryKey: queryKeys.decisions.forTargetIssue(companyId, id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(id) });
    }
    onResolved?.();
  };

  const decideMutation = useMutation({
    mutationFn: (input: { optionId: string; inputValues: Record<string, string>; idempotencyKey?: string | null }) =>
      decisionsApi.decide(decisionId, input),
    retry: 2,
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.decisions.detail(decisionId), data);
      invalidate();
    },
  });

  const compact = leading !== undefined;

  if (!recordedDecision && detail.isLoading) {
    const loading = (
      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading decision…
      </div>
    );
    return compact ? <div className="space-y-3">{loading}<DecisionCardFooter leading={leading} /></div> : loading;
  }

  if ((!recordedDecision && detail.error) || !decision) {
    const gone = (
      <p className="py-3 text-xs text-muted-foreground">
        This decision is no longer available — it may have been resolved elsewhere.
      </p>
    );
    return compact ? <div className="space-y-3">{gone}<DecisionCardFooter leading={leading} /></div> : gone;
  }

  const busy = decideMutation.isPending;
  const errorMessage = (decideMutation.error instanceof Error && decideMutation.error.message) || null;
  const decide = (optionId: string, inputValues: Record<string, string>) => decideMutation.mutate({ optionId, inputValues, idempotencyKey: crypto.randomUUID() });

  if (compact && decision.status === "open" && !decision.options.some((option) => option.effects.some((effect) => effect.type === "cancel_issue_tree"))) {
    return <CompactDecision decision={decision} resolveIssue={resolveIssue} targetChanged={targetChanged} busy={busy} errorMessage={errorMessage} leading={leading} onDecide={decide} />;
  }

  const card = (
    <DecisionCard
      decision={decision}
      executions={decision.executions}
      targetChanged={targetChanged}
      resolveIssue={resolveIssue}
      cancelTreePreview={cancelTreePreview}
      originAgentName={agentMap?.get(decision.originAgentId)?.name ?? null}
      originIssue={
        originIssue
          ? {
              id: originIssue.id,
              identifier: originIssue.identifier,
              title: originIssue.title,
              href: originIssue.href ?? issueHref(originIssue.identifier ?? originIssue.id),
              status: originIssue.status,
            }
          : null
      }
      busy={busy}
      errorMessage={errorMessage}
      onDecide={decide}
    />
  );
  return compact ? <div className="space-y-4">{card}<DecisionCardFooter leading={leading} /></div> : card;
}
