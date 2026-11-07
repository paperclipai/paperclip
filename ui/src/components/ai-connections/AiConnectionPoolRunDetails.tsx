import type { AiConnectionRouterSelection } from "@paperclipai/shared";

export function AiConnectionPoolRunDetails({ context }: { context: Record<string, unknown> | null }) {
  const selection = context?.aiRouterSelection as AiConnectionRouterSelection | undefined;
  if (!selection) return null;
  const account = context?.aiConnection as { accountName?: string; connectionId?: string } | undefined;
  const connectionId = "connectionId" in selection.binding ? selection.binding.connectionId : undefined;
  const accountName = account?.connectionId && account.connectionId !== connectionId ? undefined : account?.accountName;
  const failover = context?.aiPoolFailover as { sourceRunId?: string; reason?: string; waitingUntil?: string } | undefined;
  const waitingUntil = failover?.waitingUntil && Date.parse(failover.waitingUntil) > Date.now() ? failover.waitingUntil : undefined;
  const reasons: Record<string, string> = { quota: "usage limit reached", auth: "account authentication failed", runner: "provider process interrupted" };
  const reason = reasons[failover?.reason ?? ""];
  const config = selection.runtimeConfig;
  const effort = config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort ?? config.variant;
  return <div className="rounded-lg border p-4 text-sm space-y-1">
    <p className="font-medium">{failover?.sourceRunId ? "Backup pool account" : "Pool account"} · {accountName ?? connectionId ?? "Selected account"}</p>
    <p>{[selection.binding.provider, selection.adapterType, config.provider, config.acpxAgent, config.model, effort].filter(Boolean).map(String).join(" · ")}</p>
    {failover?.sourceRunId && reason && <p className="text-muted-foreground">Backup selected: {reason}.</p>}
    {waitingUntil && <p role="status" className="text-muted-foreground">{failover?.reason === "quota" ? "Waiting for account usage to reset." : "Waiting to retry on this account."} Retry scheduled for <time dateTime={waitingUntil}>{new Date(waitingUntil).toLocaleString()}</time>.</p>}
    {selection.notes.length > 0 && <p className="text-muted-foreground">{selection.notes.join(" ")}</p>}
  </div>;
}
