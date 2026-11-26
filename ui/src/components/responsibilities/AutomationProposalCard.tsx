import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Zap } from "lucide-react";
import type { AcceptedAutomationProposal, AutomationStartKind, ProposeAutomationInteraction } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { automationConversationsApi } from "@/api/automation-conversations";
import { describeError } from "@/api/errors";
import { issuesApi } from "@/api/issues";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/queryKeys";
import { responsibilityPath, routinePath } from "@/lib/responsibilities";
import { Link } from "@/lib/router";
import { issueUrl } from "@/lib/utils";
import { AutomationStartIcon, WebhookDetails } from "./AutomationParts";
import { localTimeZone } from "./MakeRoutineDialog";

const DEFAULT_NOT_RIGHT = "That automation isn't right yet.";

const START_KIND: Record<ProposeAutomationInteraction["payload"]["trigger"]["kind"], AutomationStartKind> = {
  schedule: "schedule",
  webhook: "webhook",
  standing_check: "standing_check",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-3 sm:gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground sm:col-span-2">{children}</dd>
    </div>
  );
}

/** "Pricing", "Pricing and Market", "Pricing, Market and Ops", as links. */
function FiledUnder({ items }: { items: ReadonlyArray<{ id: string; title: string }> }) {
  if (items.length === 0) return <span className="text-muted-foreground">No responsibility: the task is not filed under one.</span>;
  return (
    <span>
      {items.map((item, index) => (
        <span key={item.id}>
          {index > 0 ? (index === items.length - 1 ? " and " : ", ") : null}
          <Link to={responsibilityPath(item.id)} className="underline-offset-4 hover:underline">{item.title}</Link>
        </span>
      ))}
    </span>
  );
}

/** How it starts, in plain words, with what the agent said about it. */
function HowItStarts({ payload }: { payload: ProposeAutomationInteraction["payload"] }) {
  const { trigger } = payload;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <AutomationStartIcon kind={START_KIND[trigger.kind]} />
        <span>
          {trigger.kind === "schedule" ? `On a schedule: ${payload.startLabel}`
            : trigger.kind === "webhook" ? "From a webhook, when another system calls it"
              : `A standing check: ${payload.startLabel.charAt(0).toLowerCase()}${payload.startLabel.slice(1)}`}
        </span>
      </span>
      {trigger.kind === "webhook" ? <span className="text-muted-foreground">Called by: {trigger.caller}</span> : null}
      {trigger.kind === "standing_check" ? (
        <>
          <span className="text-muted-foreground">Looks for: {trigger.lookFor}</span>
          <span className="text-muted-foreground">When it finds it: {trigger.whenFound}</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * An automation an agent proposed in a task's automation conversation. It
 * reads in plain words: what will run each time, how it starts (a schedule,
 * a webhook, or a standing check on each of the agent's wake-ups), who runs
 * it and where it will be filed. **Set it up** creates it; **Not right**
 * closes the card and tells the agent what to change, and the conversation
 * carries on. After a webhook is set up, the card shows the address to call
 * and, right then only, the secret.
 */
export function AutomationProposalCard({ interaction }: { interaction: ProposeAutomationInteraction }) {
  const queryClient = useQueryClient();
  const reasonId = useId();
  const { payload, result } = interaction;
  const agentId = interaction.createdByAgentId ?? payload.assigneeAgentId;
  const [notRight, setNotRight] = useState(false);
  const [reason, setReason] = useState("");
  const [justAccepted, setJustAccepted] = useState<AcceptedAutomationProposal | null>(null);
  const agentQuery = useQuery({
    queryKey: [...queryKeys.agents.detail(agentId), interaction.companyId],
    queryFn: () => agentsApi.get(agentId, interaction.companyId),
    enabled: interaction.status === "pending",
    staleTime: 60_000,
  });

  const settle = async (updated: ProposeAutomationInteraction) => {
    queryClient.setQueriesData<ProposeAutomationInteraction[]>(
      { queryKey: ["issues", "interactions"] },
      (current) => current?.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
    );
    // Task routes key interaction caches by UUID or identifier; prefix
    // invalidation reaches whichever one is mounted. The Dashboard's
    // automation read and the routines lists show the new automation.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["issues", "interactions"] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.responsibilities.all }),
      queryClient.invalidateQueries({ queryKey: ["routines"] }),
    ]);
  };
  const accept = useMutation({
    mutationFn: () => automationConversationsApi.accept(interaction.issueId, interaction.id, localTimeZone()),
    onSuccess: async (response) => {
      setJustAccepted(response);
      await settle(response.interaction);
    },
  });
  const decline = useMutation({
    mutationFn: async (text: string) => {
      const updated = await automationConversationsApi.decline(interaction.issueId, interaction.id);
      // The person's words wake the agent in the conversation, which reopens
      // it when the agent had already finished.
      await issuesApi.addComment(interaction.issueId, text, true);
      return updated;
    },
    onSuccess: async (updated) => {
      setNotRight(false);
      setReason("");
      await Promise.all([
        settle(updated),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(interaction.issueId) }),
      ]);
    },
  });

  const sourceLink = (
    <Link to={issueUrl({ id: payload.sourceIssueId, identifier: payload.sourceIdentifier })} className="font-medium text-foreground underline-offset-4 hover:underline">
      {payload.sourceTitle}
    </Link>
  );

  if (interaction.status === "accepted") {
    const routineId = result?.routineId ?? justAccepted?.routine.id ?? null;
    const webhookUrl = justAccepted?.webhook?.url ?? result?.webhookUrl ?? null;
    return (
      <div id={`interaction-${interaction.id}`} data-testid="automation-proposal-accepted" className="flex min-w-0 flex-col gap-2 text-sm text-muted-foreground">
        <div className="flex min-w-0 items-start gap-2">
          <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {routineId ? (
            <span className="min-w-0">
              Automation set up:{" "}
              <Link to={routinePath(routineId)} className="font-medium text-foreground underline-offset-4 hover:underline">
                {result?.routineTitle ?? payload.title}
              </Link>
              {" "}· {payload.startLabel}
            </span>
          ) : (
            <span>Setting up the automation…</span>
          )}
        </div>
        {payload.trigger.kind === "webhook" && webhookUrl ? (
          <WebhookDetails
            url={webhookUrl}
            secret={justAccepted?.webhook?.secret ?? null}
            signingMode={justAccepted?.webhook?.signingMode ?? result?.signingMode}
            routineHref={routineId ? routinePath(routineId) : null}
          />
        ) : null}
      </div>
    );
  }
  if (interaction.status === "rejected" || result?.outcome === "replaced") {
    return (
      <p id={`interaction-${interaction.id}`} data-testid="automation-proposal-closed" className="text-sm text-muted-foreground">
        {result?.outcome === "replaced" ? "Proposed automation, replaced by a newer one: " : "Not this automation: "}
        {payload.title} ({payload.startLabel})
      </p>
    );
  }
  if (interaction.status !== "pending") return null;

  const agentName = agentQuery.data?.name ?? payload.agentName;
  const busy = accept.isPending || decline.isPending;
  const error = accept.error ?? decline.error;
  const submitNotRight = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    decline.mutate(reason.trim() || DEFAULT_NOT_RIGHT);
  };
  return (
    <article id={`interaction-${interaction.id}`} data-testid="automation-proposal" data-trigger={payload.trigger.kind}
      aria-label={`Proposed automation for ${payload.sourceTitle}`}
      className="rounded-md border border-border bg-card/60 px-3 py-3">
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agentQuery.data ?? undefined} name={agentName} size={24} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium text-foreground">
              {agentName} proposed an automation for {sourceLink}
            </p>
            {payload.message ? <p className="text-sm text-foreground">{payload.message}</p> : null}
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <Zap aria-hidden className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-base text-foreground">{payload.title}</p>
          </div>
          <dl className="flex flex-col gap-2">
            <Row label="Each time">
              <span className="line-clamp-4 whitespace-pre-line" title={payload.instructions}>{payload.instructions}</span>
            </Row>
            <Row label="How it starts"><HowItStarts payload={payload} /></Row>
            <Row label="Who runs it">{agentName}</Row>
            <Row label="Filed under"><FiledUnder items={payload.filedUnder} /></Row>
          </dl>
          {payload.trigger.kind === "webhook" ? (
            <p className="text-xs text-muted-foreground">Once it is set up, you get the address to call and its secret to give that system.</p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">{describeError(error).body}</p>
          ) : null}
          {notRight ? (
            <form className="flex flex-col gap-2" onSubmit={submitNotRight}>
              <label htmlFor={reasonId} className="text-xs text-muted-foreground">What should change? (optional)</label>
              <Textarea
                id={reasonId}
                rows={2}
                value={reason}
                autoFocus
                placeholder="e.g. Run it on Mondays instead, and only for paying customers"
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setNotRight(false)}>
                  Back
                </Button>
                <Button type="submit" size="sm" variant="outline" disabled={busy}>
                  {decline.isPending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
                  Send
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setNotRight(true)}>
                Not right
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => accept.mutate()}>
                {accept.isPending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Check aria-hidden className="h-4 w-4" />}
                Set it up
              </Button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
