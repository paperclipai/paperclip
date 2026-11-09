import { describeError } from "@/api/errors";
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DotPairing } from "@paperclipai/shared";
import { grokBotApi } from "@/api/grokBot";
import { buildGrokAccessPrompt, buildGrokRoutinePrompt } from "@/lib/grok-bot-setup-prompt";
import { AgentSetupPrompt } from "./AgentSetupPrompt";
import { CopyText } from "./CopyText";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";

/** Configuration writes update the authoritative binding, never an unsaved agent form. */
export function GrokBotConnection({ companyId, agentId }: { companyId?: string; agentId?: string }) {
  const { t } = useTranslation();
  const pairingCodeId = useId();
  const cache = useQueryClient();
  const key = ["grok-binding", companyId, agentId];
  const state = useQuery({ queryKey: key, enabled: !!companyId && !!agentId,
    queryFn: ({ signal }) => grokBotApi.connection(companyId!, agentId!, signal), refetchInterval: 5000 });
  const [pairing, setPairing] = useState<DotPairing | null>(null);
  const [replace, setReplace] = useState(false);
  const [botName, setBotName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookKey, setWebhookKey] = useState("");
  const [inspected, setInspected] = useState(false);
  const verifyRequest = useRef<string | null>(null);
  const binding = state.data?.binding, routine = binding?.routine, exchange = routine?.lastExchange;
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: key });
    if (companyId && agentId) await cache.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
  };
  const pair = useMutation({ mutationFn: async () => { setPairing(await grokBotApi.pair(companyId!, agentId!, binding?.status === "pairing" ? binding.id : undefined)); }, onSuccess: refresh, gcTime: 0 });
  const configure = useMutation({ mutationFn: async () => {
    await grokBotApi.configure(companyId!, agentId!, { bindingId: binding!.id, expectedRevision: routine?.revision ?? 0, botName, webhookUrl, webhookKey });
    setWebhookUrl(""); setWebhookKey(""); setReplace(false); verifyRequest.current = null;
  }, onSuccess: refresh, gcTime: 0 });
  const verify = useMutation({ mutationFn: async () => {
    if (["rejected", "cancelled"].includes(exchange?.status ?? "")) verifyRequest.current = null;
    verifyRequest.current ??= crypto.randomUUID();
    await grokBotApi.verify(companyId!, agentId!, binding!.id, verifyRequest.current);
  }, onSuccess: refresh, gcTime: 0 });
  const retryDelivery = useMutation({ mutationFn: (correlationId: string) => grokBotApi.retry(companyId!, agentId!, correlationId), onSuccess: refresh });
  const disconnect = useMutation({ mutationFn: () => grokBotApi.disconnect(companyId!, agentId!), onSuccess: async () => { setPairing(null); await refresh(); } });
  const recover = useMutation({ mutationFn: () => grokBotApi.recover(companyId!, agentId!), onSuccess: async () => { setInspected(false); verifyRequest.current = null; await refresh(); } });
  const stop = useMutation({ mutationFn: (runId: string) => grokBotApi.stop(companyId!, agentId!, runId), onSuccess: refresh });
  useEffect(() => { if (routine?.botName) setBotName(routine.botName); }, [routine?.botName]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => setPairing(null), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);
  if (!agentId) return <p className="text-sm text-muted-foreground">{t("agents.grokBotConnection.saveFirst")}</p>;
  const busy = pair.isPending || configure.isPending || verify.isPending || disconnect.isPending || recover.isPending || stop.isPending || retryDelivery.isPending;
  const error = state.error ?? pair.error ?? configure.error ?? verify.error ?? disconnect.error ?? recover.error ?? stop.error ?? retryDelivery.error;
  const recovering = state.data?.recoveryNeeded || routine?.recoveryNeeded;
  const pending = exchange && ["prepared", "sending", "accepted"].includes(exchange.status) && Date.parse(exchange.expiresAt) > Date.now();
  return <section aria-label={t("agents.grokBotConnection.sectionLabel")} className="space-y-4 text-sm">
    <p className="text-muted-foreground">{t("agents.grokBotConnection.intro")}</p>
    {state.isPending && <p role="status">{t("agents.grokBotConnection.loading")}</p>}
    {error && <p role="alert" className="text-destructive">{describeError(error).body}</p>}
    {state.data && !state.data.enabled && <p className="text-muted-foreground">{t("agents.grokBotConnection.enableHint")}</p>}
    {binding?.connected ? <>
      <p>{t("agents.grokBotConnection.accessConnected")} {routine?.verified && !recovering ? t("agents.grokBotConnection.roundTripVerified") : t("agents.grokBotConnection.assignmentsRequireVerified")}</p>
      <dl className="space-y-2 text-muted-foreground"><div><dt>{t("agents.grokBotConnection.bot")}</dt><dd>{routine?.botName ?? t("agents.grokBotConnection.notConfigured")}</dd></div><div><dt>{t("agents.grokBotConnection.lastVerifiedExchange")}</dt><dd>{routine?.verifiedAt ? new Date(routine.verifiedAt).toLocaleString() : t("agents.grokBotConnection.notYetVerified")}</dd></div><div><dt>{t("agents.grokBotConnection.lastContact")}</dt><dd>{routine?.lastContactAt ? new Date(routine.lastContactAt).toLocaleString() : t("agents.grokBotConnection.notYetObserved")}</dd></div></dl>
      {exchange && <p>{t("agents.grokBotConnection.deliveryLine", { delivered: ["accepted", "acknowledged"].includes(exchange.status) ? t("agents.grokBotConnection.yes") : t("agents.grokBotConnection.unconfirmed"), received: exchange.acknowledgedAt ? t("agents.grokBotConnection.yes") : t("agents.grokBotConnection.no") })}</p>}
      {exchange?.status === "rejected" && <div className="space-y-2"><p>{t("agents.grokBotConnection.rejectedDelivery")}</p><Button variant="outline" disabled={busy || recovering} onClick={() => retryDelivery.mutate(exchange.id)}>{t("agents.grokBotConnection.retryRejected")}</Button></div>}
      {!routine?.configured || replace ? <div className="space-y-3">
        <label className="block space-y-2"><span>{t("agents.grokBotConnection.botNameInGrok")}</span><Input value={botName} onChange={e => setBotName(e.target.value)} maxLength={100} /></label>
        <AgentSetupPrompt prompt={buildGrokRoutinePrompt(binding.id, botName || "your Bot")} label={t("agents.grokBotConnection.routineInstructions")} title={t("agents.grokBotConnection.enableAssignments")} description={t("agents.grokBotConnection.routineInstructionsHelp")} />
        <label className="block space-y-2"><span>{t("agents.grokBotConnection.webhookUrl")}</span><Input type="password" autoComplete="off" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} /></label>
        <label className="block space-y-2"><span>{t("agents.grokBotConnection.webhookKey")}</span><Input type="password" autoComplete="off" value={webhookKey} onChange={e => setWebhookKey(e.target.value)} /></label>
        <Button disabled={busy || recovering || !botName.trim() || !webhookUrl || !webhookKey} onClick={() => configure.mutate()}>{t("agents.grokBotConnection.saveRoutine")}</Button>
      </div> : <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !!pending || recovering || !!binding.assignment} onClick={() => verify.mutate()}>{t("agents.grokBotConnection.verifyConnection")}</Button>
        <Button variant="outline" disabled={busy || recovering || !!binding.assignment} onClick={() => setReplace(true)}>{t("agents.grokBotConnection.replaceCredentials")}</Button>
      </div>}
    </> : <>
      <Button disabled={busy || !state.data?.enabled || !state.data.canConfigureConnection} onClick={() => pair.mutate()}>{t("agents.grokBotConnection.reconnectAccess")}</Button>
      {pairing && state.data?.resourceUrl && <>
        <AgentSetupPrompt prompt={buildGrokAccessPrompt(state.data.resourceUrl, botName || "your Bot")} label={t("agents.grokBotConnection.connectionInstructions")} title={t("agents.grokBotConnection.reconnectGrokBot")} description={t("agents.grokBotConnection.reconnectHelp")} />
        <div className="space-y-2">
          <label htmlFor={pairingCodeId}>{t("agents.grokBotConnection.pairingCodeLabel")}</label>
          <div className="flex items-center gap-2">
            <Input id={pairingCodeId} type="password" autoComplete="off" readOnly value={pairing.pairingCode} onFocus={e => e.target.select()} />
            <CopyText text={pairing.pairingCode} ariaLabel={t("agents.grokBotConnection.copyPairingCode")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t("agents.grokBotConnection.copyCode")}</CopyText>
          </div>
          <p className="text-xs text-muted-foreground">{t("agents.grokBotConnection.pairingCodeHelp")}</p>
        </div>
      </>}
    </>}
    {binding?.assignment && <div className="space-y-2"><p>{binding.assignment.status === "offered" ? t("agents.grokBotConnection.awaitingAck") : t("agents.grokBotConnection.workingSession")}</p><Button variant="outline" disabled={busy} onClick={() => stop.mutate(binding.assignment!.runId)}>{t("agents.grokBotConnection.stopWork")}</Button><p className="text-xs text-muted-foreground">{t("agents.grokBotConnection.revokeHelp")}</p></div>}
    {recovering && <div className="space-y-3 rounded-md border border-border p-3">
      <p className="font-medium">{t("agents.grokBotConnection.recoveryNeeded")}</p><p className="text-muted-foreground">{t("agents.grokBotConnection.recoveryHelp")}</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={inspected} onChange={e => setInspected(e.target.checked)} /><span>{t("agents.grokBotConnection.inspected")}</span></label>
      <Button variant="outline" disabled={busy || !inspected || !!binding?.assignment} onClick={() => recover.mutate()}>{t("agents.grokBotConnection.clearRecovery")}</Button>
      <p className="text-xs text-muted-foreground">{t("agents.grokBotConnection.recoveryRecorded")}</p>
    </div>}
    {binding?.connected && <Button variant="outline" disabled={busy} onClick={() => disconnect.mutate()}>{t("agents.grokBotConnection.disconnect")}</Button>}
  </section>;
}
