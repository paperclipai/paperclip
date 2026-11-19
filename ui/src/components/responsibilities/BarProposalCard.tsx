import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Target } from "lucide-react";
import { RESPONSIBILITY_METRIC_DISPLAY_LABEL, type ProposeResponsibilityBarInteraction } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { issuesApi } from "@/api/issues";
import { responsibilityBarsApi } from "@/api/responsibility-bars";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { proposalMetricPreview } from "@/lib/metric-charts";
import { queryKeys } from "@/lib/queryKeys";
import { responsibilityPath } from "@/lib/responsibilities";
import { Link } from "@/lib/router";
import { ResponsibilityHealthBadge } from "./ResponsibilityHealthBadge";
import { MetricTile } from "./ResponsibilityMetricSet";

const DEFAULT_NOT_RIGHT = "That bar isn't right yet.";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-3 sm:gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground sm:col-span-2">{children}</dd>
    </div>
  );
}

/**
 * The metric set a proposal carries, drawn as it will appear: the bar's own
 * metric, then each supporting metric with how it is measured and any
 * starting readings. Readings come from the agent's evidence, never guesses.
 */
function ProposedMetricSet({ interaction }: { interaction: ProposeResponsibilityBarInteraction }) {
  const now = useMemo(() => new Date(), []);
  const preview = proposalMetricPreview(interaction.payload, now);
  if (!preview) return null;
  const evidence = (interaction.payload.metrics ?? []).map((metric) => metric.readingsEvidence).filter(Boolean);
  return (
    <section aria-label="Proposed metrics" className="flex flex-col gap-3 border-t border-border pt-3" data-proposed-metrics="">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-xs font-medium text-muted-foreground">
          {preview.metrics.length === 1 ? "The metric" : `${preview.metrics.length} metrics`} on the page
        </h4>
        {preview.keepsSupporting ? (
          <p className="text-xs text-muted-foreground">Keeps the supporting metrics it has.</p>
        ) : preview.metrics.length === 1 ? (
          <p className="text-xs text-muted-foreground">Only the bar’s own metric; any supporting metrics are removed.</p>
        ) : null}
      </div>
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2" data-metric-layout="proposal">
        {preview.metrics.map((metric) => (
          <MetricTile
            key={metric.key}
            metric={metric}
            now={now}
            primary={metric.role === "primary" ? preview.primary : null}
            caption={`${metric.role === "primary" ? "The bar’s metric · " : ""}${RESPONSIBILITY_METRIC_DISPLAY_LABEL[metric.display]}`}
            showReadLine={false}
            className="rounded-md border border-border px-3 py-2.5"
          />
        ))}
      </div>
      {evidence.length > 0 ? (
        <p className="text-xs text-muted-foreground">Starting readings: {evidence.join(" ")}</p>
      ) : null}
    </section>
  );
}

/**
 * Accepting a proposed bar (optionally with only some of its supporting
 * metrics, by index) and saying it is not right (the person's words wake the
 * agent in the conversation). Both refresh every read that shows the bar.
 */
export function useBarProposalActions(interaction: Pick<ProposeResponsibilityBarInteraction, "id" | "issueId">) {
  const queryClient = useQueryClient();
  const settle = async (updated: ProposeResponsibilityBarInteraction) => {
    queryClient.setQueriesData<ProposeResponsibilityBarInteraction[]>(
      { queryKey: ["issues", "interactions"] },
      (current) => current?.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
    );
    // Task routes key interaction caches by UUID or identifier; prefix
    // invalidation reaches whichever one is mounted. The responsibility's
    // page, its views and its conversation state all read the new bar.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["issues", "interactions"] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all }),
    ]);
  };
  const accept = useMutation({
    mutationFn: (keepMetrics?: number[]) => keepMetrics === undefined
      ? responsibilityBarsApi.accept(interaction.issueId, interaction.id)
      : responsibilityBarsApi.accept(interaction.issueId, interaction.id, { keepMetrics }),
    onSuccess: (response) => settle(response.interaction),
  });
  const decline = useMutation({
    mutationFn: async (text: string) => {
      const updated = await responsibilityBarsApi.decline(interaction.issueId, interaction.id);
      // The person's words wake the agent in the conversation, which reopens
      // it when the agent had already finished.
      await issuesApi.addComment(interaction.issueId, text, true);
      return updated;
    },
    onSuccess: async (updated) => {
      await Promise.all([
        settle(updated),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(interaction.issueId) }),
      ]);
    },
  });
  return { accept, decline, busy: accept.isPending || decline.isPending, error: accept.error ?? decline.error };
}

/** "What should change?": one optional line to the agent, sent with Not right. */
export function NotRightForm({
  busy,
  sending,
  onSend,
  onBack,
  defaultText = DEFAULT_NOT_RIGHT,
  placeholder = "e.g. Count only paying customers, and the target should be higher",
}: {
  busy: boolean;
  sending: boolean;
  onSend: (text: string) => void;
  onBack: () => void;
  /** Sent when the person writes nothing. */
  defaultText?: string;
  placeholder?: string;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    onSend(reason.trim() || defaultText);
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label htmlFor={reasonId} className="text-xs text-muted-foreground">What should change? (optional)</label>
      <Textarea
        id={reasonId}
        rows={2}
        value={reason}
        autoFocus
        placeholder={placeholder}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          {sending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
          Send
        </Button>
      </div>
    </form>
  );
}

/**
 * A bar an agent proposed in a responsibility's bar conversation. It reads in
 * plain words: the sentence, the template, what is measured, the target (or
 * yes, or the range), the reading when the agent had evidence for one, and how
 * status will be read; and, when it carries one, the metric set as it will
 * appear (up to two supporting metrics beside the bar's own). **Use this bar**
 * applies it to the responsibility, replacing its supporting metrics;
 * **Not right** closes the card and tells the agent what to change, and the
 * conversation carries on. Shown in the conversation and on the
 * responsibility's page while it waits.
 */
export function BarProposalCard({
  interaction,
  showConversationLink = false,
  showResponsibilityLink = true,
}: {
  interaction: ProposeResponsibilityBarInteraction;
  /** On the responsibility's page: link to the conversation it came from. */
  showConversationLink?: boolean;
  /** In the conversation: link back to the responsibility. */
  showResponsibilityLink?: boolean;
}) {
  const { payload, result } = interaction;
  const agentId = interaction.createdByAgentId;
  const [notRight, setNotRight] = useState(false);
  const { accept, decline, busy, error } = useBarProposalActions(interaction);
  const agentQuery = useQuery({
    queryKey: [...queryKeys.agents.detail(agentId ?? ""), interaction.companyId],
    queryFn: () => agentsApi.get(agentId!, interaction.companyId),
    enabled: interaction.status === "pending" && !!agentId,
    staleTime: 60_000,
  });


  const responsibilityLink = showResponsibilityLink ? (
    <Link to={responsibilityPath(payload.responsibilityId)} className="font-medium text-foreground underline-offset-4 hover:underline">
      {payload.responsibilityTitle}
    </Link>
  ) : null;

  if (interaction.status === "accepted") {
    const keptSupporting = Math.max(0, (payload.metrics?.length ?? 0) - (result?.droppedMetrics?.length ?? 0));
    return (
      <div id={`interaction-${interaction.id}`} data-testid="bar-proposal-accepted"
        className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground">
        <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0">
          Bar set{responsibilityLink ? <> for {responsibilityLink}</> : null}: {payload.bar.standard}
          {keptSupporting > 0
            ? ` With ${keptSupporting === 1 ? "1 supporting metric" : `${keptSupporting} supporting metrics`}.`
            : null}
        </span>
      </div>
    );
  }
  if (interaction.status === "rejected" || result?.outcome === "replaced") {
    return (
      <p id={`interaction-${interaction.id}`} data-testid="bar-proposal-closed" className="text-sm text-muted-foreground">
        {result?.outcome === "replaced" ? "Proposed bar, replaced by a newer one: " : "Not this bar: "}
        {payload.bar.standard}
      </p>
    );
  }
  if (interaction.status !== "pending") return null;

  const agentName = agentQuery.data?.name ?? "Your agent";
  return (
    <article id={`interaction-${interaction.id}`} data-testid="bar-proposal"
      aria-label={`Proposed bar for ${payload.responsibilityTitle}`}
      className="rounded-md border border-border bg-card/60 px-3 py-3">
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agentQuery.data ?? undefined} name={agentName} size={24} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium text-foreground">
              {agentName} proposed a bar{responsibilityLink ? <> for {responsibilityLink}</> : null}
            </p>
            {payload.message ? <p className="text-sm text-foreground">{payload.message}</p> : null}
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <Target aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-base text-foreground">{payload.bar.standard}</p>
          </div>
          <dl className="flex flex-col gap-2">
            <Row label="Kind of measure">{payload.templateLabel}</Row>
            <Row label="What is measured">{payload.bar.metricName}</Row>
            <Row label="The bar">{payload.targetLabel}</Row>
            {payload.readingLabel ? (
              <Row label="Where it is now">
                <span className="tabular-nums">{payload.readingLabel}</span>
                {payload.currentEvidence ? <span className="text-muted-foreground"> · {payload.currentEvidence}</span> : null}
              </Row>
            ) : null}
            <Row label="How status is read">{payload.statusRule}</Row>
            {payload.preview ? (
              <Row label="Status with it">
                <span className="flex flex-wrap items-center gap-2">
                  <ResponsibilityHealthBadge health={payload.preview.health} />
                  <span className="text-muted-foreground">{payload.preview.statusSentence}</span>
                </span>
              </Row>
            ) : null}
          </dl>
          <ProposedMetricSet interaction={interaction} />
          {error ? (
            <p className="text-sm text-destructive" role="alert">{describeError(error).body}</p>
          ) : null}
          {notRight ? (
            <NotRightForm
              busy={busy}
              sending={decline.isPending}
              onSend={(text) => decline.mutate(text, { onSuccess: () => setNotRight(false) })}
              onBack={() => setNotRight(false)}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {showConversationLink ? (
                <Button asChild type="button" variant="ghost" size="sm">
                  <Link to={`/issues/${interaction.issueId}`}>Open the conversation</Link>
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setNotRight(true)}>
                Not right
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => accept.mutate(undefined)}>
                {accept.isPending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Check aria-hidden className="h-4 w-4" />}
                Use this bar
              </Button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
