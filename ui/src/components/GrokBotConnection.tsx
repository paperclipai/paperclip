import { i18n, t, useTranslation } from "@/i18n";
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

/** Configuration writes update the authoritative binding, never an unsaved agent form. */
export function GrokBotConnection({ companyId, agentId }: { companyId?: string; agentId?: string }) {
  useTranslation();
  const pairingCodeId = useId();
  const cache = useQueryClient();
  const key = ["grok-binding", companyId, agentId];
  const state = useQuery({ queryKey: key, enabled: !!companyId && !!agentId,
    queryFn: ({ signal }) => grokBotApi.connection(companyId!, agentId!, signal), retry: false, refetchInterval: 5000 });
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
  if (!agentId) return <p className="text-sm text-muted-foreground">{t("oct19Voice.saveTheGrokBotAgentBefore_1mog16c")}</p>;
  const busy = pair.isPending || configure.isPending || verify.isPending || disconnect.isPending || recover.isPending || stop.isPending || retryDelivery.isPending;
  const error = state.error ?? pair.error ?? configure.error ?? verify.error ?? disconnect.error ?? recover.error ?? stop.error ?? retryDelivery.error;
  const recovering = state.data?.recoveryNeeded || routine?.recoveryNeeded;
  const pending = exchange && ["prepared", "sending", "accepted"].includes(exchange.status) && Date.parse(exchange.expiresAt) > Date.now();
  return <section aria-label={t("oct19Voice.grokBotConnection_1mf4hbx")} className="space-y-4 text-sm">
    <p className="text-muted-foreground">{t("oct19Voice.runsInGrokBotTheBot_1ph0v89")}</p>
    {state.isPending && <p role="status">{t("oct19Voice.loadingConnection_1x4y665")}</p>}
    {error && <p role="alert" className="text-destructive">{error.message}</p>}
    {state.data && !state.data.enabled && <p className="text-muted-foreground">{t("oct19Voice.enableGrokBotAssistantConnectionsMcp_3da71b")}</p>}
    {binding?.connected ? <>
      <p>{t("oct19Voice.agentAccessConnected_10ouh5j")} {routine?.verified && !recovering ? t("oct19Voice.routineRoundTripVerified_1c04mpc") : t("oct19Voice.assignmentsRequireAVerifiedRoutineRound_r7lqak")}</p>
      <dl className="space-y-2 text-muted-foreground"><div><dt>{t("oct19Voice.bot_1ofhrmm")}</dt><dd>{routine?.botName ?? t("oct19Voice.notConfigured_4tqh3i")}</dd></div><div><dt>{t("oct19Voice.lastVerifiedExchange_6hrz3k")}</dt><dd>{routine?.verifiedAt ? new Date(routine.verifiedAt).toLocaleString(i18n.resolvedLanguage) : t("oct19Voice.notYetVerified_hcu9jk")}</dd></div><div><dt>{t("oct19Voice.lastAuthenticatedContact_tn2xge")}</dt><dd>{routine?.lastContactAt ? new Date(routine.lastContactAt).toLocaleString(i18n.resolvedLanguage) : t("oct19Voice.notYetObserved_16l8a44")}</dd></div></dl>
      {exchange && <p>{t("oct19Voice.grokDelivery", { delivered: ["accepted", "acknowledged"].includes(exchange.status) ? t("oct19Voice.yes_1dudzcg") : t("oct19Voice.unconfirmed_126zmar"), replied: exchange.acknowledgedAt ? t("oct19Voice.yes_1dudzcg") : t("oct19Voice.no_r5wqai") })}</p>}
      {exchange?.status === "rejected" && <div className="space-y-2"><p>{t("oct19Voice.theRoutineRejectedThisDeliveryCheck_1lhpd30")}</p><Button variant="outline" disabled={busy || recovering} onClick={() => retryDelivery.mutate(exchange.id)}>{t("oct19Voice.retryRejectedDelivery_7qoy4b")}</Button></div>}
      {!routine?.configured || replace ? <div className="space-y-3">
        <label className="block space-y-2"><span>{t("oct19Voice.botNameInGrok_1c2y267")}</span><Input value={botName} onChange={e => setBotName(e.target.value)} maxLength={100} /></label>
        <AgentSetupPrompt prompt={buildGrokRoutinePrompt(binding.id, botName || "your Bot")} label={t("oct19Voice.copyRoutineInstructions_a0abjh")} title={t("oct19Voice.enableAssignments_ktcowc")} description={t("oct19Voice.askTheBotForAWebhook_min1fn")} />
        <label className="block space-y-2"><span>{t("oct19Voice.webhookUrl_ijsn3v")}</span><Input type="password" autoComplete="off" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} /></label>
        <label className="block space-y-2"><span>{t("oct19Voice.webhookKey_nzli0p")}</span><Input type="password" autoComplete="off" value={webhookKey} onChange={e => setWebhookKey(e.target.value)} /></label>
        <Button disabled={busy || recovering || !botName.trim() || !webhookUrl || !webhookKey} onClick={() => configure.mutate()}>{t("oct19Voice.saveRoutine_1jli1js")}</Button>
      </div> : <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !!pending || recovering || !!binding.assignment} onClick={() => verify.mutate()}>{t("oct19Voice.verifyConnection_1v2fb24")}</Button>
        <Button variant="outline" disabled={busy || recovering || !!binding.assignment} onClick={() => setReplace(true)}>{t("oct19Voice.replaceRoutineCredentials_13pno8h")}</Button>
      </div>}
    </> : <>
      <Button disabled={busy || !state.data?.enabled || !state.data.canConfigureConnection} onClick={() => pair.mutate()}>{t("oct19Voice.reconnectAgentAccess_4m640b")}</Button>
      {pairing && state.data?.resourceUrl && <>
        <AgentSetupPrompt prompt={buildGrokAccessPrompt(state.data.resourceUrl, botName || "your Bot")} label={t("oct19Voice.copyConnectionInstructions_1utxah9")} title={t("oct19Voice.reconnectGrokBot_5owsso")} description={t("oct19Voice.completeOauthInTheBrowserKeep_1j6b6t7")} />
        <div className="space-y-2">
          <label htmlFor={pairingCodeId}>{t("oct19Voice.oneUsePairingCode_ysxala")}</label>
          <div className="flex items-center gap-2">
            <Input id={pairingCodeId} type="password" autoComplete="off" readOnly value={pairing.pairingCode} onFocus={e => e.target.select()} />
            <CopyText text={pairing.pairingCode} ariaLabel={t("oct19Voice.copyPairingCode_bperj1")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t("oct19Voice.copyCode_106qgkp")}</CopyText>
          </div>
          <p className="text-xs text-muted-foreground">{t("oct19Voice.copyThisCodeIntoPaperclipS_1a74uh7")}</p>
        </div>
      </>}
    </>}
    {binding?.assignment && <div className="space-y-2"><p>{binding.assignment.status === "offered" ? t("oct19Voice.awaitingAcknowledgement_b2lazn") : t("oct19Voice.workingInAPaperclipWorkSession_nlb0ld")}</p><Button variant="outline" disabled={busy} onClick={() => stop.mutate(binding.assignment!.runId)}>{t("oct19Voice.stopPaperclipWork_shyq6q")}</Button><p className="text-xs text-muted-foreground">{t("oct19Voice.revokesThisSessionSPaperclipAuthority_sf9wqq")}</p></div>}
    {recovering && <div className="space-y-3 rounded-md border border-border p-3">
      <p className="font-medium">{t("oct19Voice.recoveryNeeded_r3xtgz")}</p><p className="text-muted-foreground">{t("oct19Voice.paperclipCannotDetermineWhetherGrokIs_1ehal34")}</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={inspected} onChange={e => setInspected(e.target.checked)} /><span>{t("oct19Voice.iInspectedGrokAndResolvedThe_7u9zs8")}</span></label>
      <Button variant="outline" disabled={busy || !inspected || !!binding?.assignment} onClick={() => recover.mutate()}>{t("oct19Voice.clearRecoveryHold_1qxpa76")}</Button>
      <p className="text-xs text-muted-foreground">{t("oct19Voice.thisRecordsYourInspectionItDoes_t2pv8p")}</p>
    </div>}
    {binding?.connected && <Button variant="outline" disabled={busy} onClick={() => disconnect.mutate()}>{t("oct19Voice.disconnectAgentAccess_14p6urc")}</Button>}
  </section>;
}
