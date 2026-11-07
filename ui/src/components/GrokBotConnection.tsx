import { useTranslation } from "@/i18n";
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

/** Configuration writes update the authoritative binding, never an unsaved agent form. */
export function GrokBotConnection({ companyId, agentId }: { companyId?: string; agentId?: string }) {
  const { t } = useTranslation("connections");
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
  if (!agentId) return <p className="text-sm text-muted-foreground">{t("save_the_grok_bot_agent_before_connecting_96df565")}</p>;
  const busy = pair.isPending || configure.isPending || verify.isPending || disconnect.isPending || recover.isPending || stop.isPending || retryDelivery.isPending;
  const error = state.error ?? pair.error ?? configure.error ?? verify.error ?? disconnect.error ?? recover.error ?? stop.error ?? retryDelivery.error;
  const recovering = state.data?.recoveryNeeded || routine?.recoveryNeeded;
  const pending = exchange && ["prepared", "sending", "accepted"].includes(exchange.status) && Date.parse(exchange.expiresAt) > Date.now();
  return <section aria-label={t("grok_bot_connection_bc925f4")} className="space-y-4 text-sm">
    <p className="text-muted-foreground">{t("runs_in_grok_bot_the_bot_retains_176f654")}</p>
    {state.isPending && <p role="status">{t("loading_connection_f1e8532")}</p>}
    {error && <p role="alert" className="text-destructive">{describeError(error).body}</p>}
    {state.data && !state.data.enabled && <p className="text-muted-foreground">{t("enable_grok_bot_assistant_connections_mcp_and_691adfb")}</p>}
    {binding?.connected ? <>
      <p>{t("agent_access_connected_2fa9bde", { verificationStatus: routine?.verified && !recovering ? t("reviewBRoutineVerified") : t("reviewBRoutineRequired") })}</p>
      <dl className="space-y-2 text-muted-foreground"><div><dt>{t("bot_3a3192e")}</dt><dd>{routine?.botName ?? t("not_configured_811931b")}</dd></div><div><dt>{t("last_verified_exchange_fd42430")}</dt><dd>{routine?.verifiedAt ? new Date(routine.verifiedAt).toLocaleString() : t("not_yet_verified_a9b0cdd")}</dd></div><div><dt>{t("last_authenticated_contact_9e2c829")}</dt><dd>{routine?.lastContactAt ? new Date(routine.lastContactAt).toLocaleString() : t("not_yet_observed_a11ecc2")}</dd></div></dl>
      {exchange && <p>{t("assignment_delivered_reply_received_937fb04", { deliveryStatus: ["accepted", "acknowledged"].includes(exchange.status) ? t("reviewBYes") : t("reviewBUnconfirmed"), replyStatus: exchange.acknowledgedAt ? t("reviewBYes") : t("reviewBNo") })}</p>}
      {exchange?.status === "rejected" && <div className="space-y-2"><p>{t("the_routine_rejected_this_delivery_check_the_11f1adb")}</p><Button variant="outline" disabled={busy || recovering} onClick={() => retryDelivery.mutate(exchange.id)}>{t("retry_rejected_delivery_6936640")}</Button></div>}
      {!routine?.configured || replace ? <div className="space-y-3">
        <label className="block space-y-2"><span>{t("bot_name_in_grok_01c6f8b")}</span><Input value={botName} onChange={e => setBotName(e.target.value)} maxLength={100} /></label>
        <AgentSetupPrompt prompt={buildGrokRoutinePrompt(binding.id, botName || "your Bot")} label={t("copy_routine_instructions_1181be1")} title={t("enable_assignments_45d6602")} description={t("ask_the_bot_for_a_webhook_url_fe69319")} />
        <label className="block space-y-2"><span>{t("webhook_url_fa7517b")}</span><Input type="password" autoComplete="off" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} /></label>
        <label className="block space-y-2"><span>{t("webhook_key_4874a0a")}</span><Input type="password" autoComplete="off" value={webhookKey} onChange={e => setWebhookKey(e.target.value)} /></label>
        <Button disabled={busy || recovering || !botName.trim() || !webhookUrl || !webhookKey} onClick={() => configure.mutate()}>{t("save_routine_9f773c3")}</Button>
      </div> : <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !!pending || recovering || !!binding.assignment} onClick={() => verify.mutate()}>{t("verify_connection_a5073da")}</Button>
        <Button variant="outline" disabled={busy || recovering || !!binding.assignment} onClick={() => setReplace(true)}>{t("replace_routine_credentials_8b80720")}</Button>
      </div>}
    </> : <>
      <Button disabled={busy || !state.data?.enabled || !state.data.canConfigureConnection} onClick={() => pair.mutate()}>{t("reconnect_agent_access_638c513")}</Button>
      {pairing && state.data?.resourceUrl && <>
        <AgentSetupPrompt prompt={buildGrokAccessPrompt(state.data.resourceUrl, botName || "your Bot")} label={t("copy_connection_instructions_8fd7e8d")} title={t("reconnect_grok_bot_1461e80")} description={t("complete_oauth_in_the_browser_keep_this_adf169a")} />
        <div className="space-y-2">
          <label htmlFor={pairingCodeId}>{t("one_use_pairing_code_5279abe")}</label>
          <div className="flex items-center gap-2">
            <Input id={pairingCodeId} type="password" autoComplete="off" readOnly value={pairing.pairingCode} onFocus={e => e.target.select()} />
            <CopyText text={pairing.pairingCode} ariaLabel={t("copy_pairing_code_d9898ea")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t("copy_code_6c10692")}</CopyText>
          </div>
          <p className="text-xs text-muted-foreground">{t("copy_this_code_into_paperclip_s_authorization_525809d")}</p>
        </div>
      </>}
    </>}
    {binding?.assignment && <div className="space-y-2"><p>{binding.assignment.status === "offered" ? t("awaiting_acknowledgement_c351a0f") : t("working_in_a_paperclip_work_session_de83c9e")}</p><Button variant="outline" disabled={busy} onClick={() => stop.mutate(binding.assignment!.runId)}>{t("stop_paperclip_work_9132ce0")}</Button><p className="text-xs text-muted-foreground">{t("revokes_this_session_s_paperclip_authority_and_be558ce")}</p></div>}
    {recovering && <div className="space-y-3 rounded-md border border-border p-3">
      <p className="font-medium">{t("recovery_needed_7bdda42")}</p><p className="text-muted-foreground">{t("paperclip_cannot_determine_whether_grok_is_still_0114b3c")}</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={inspected} onChange={e => setInspected(e.target.checked)} /><span>{t("i_inspected_grok_and_resolved_the_old_2b2cb21")}</span></label>
      <Button variant="outline" disabled={busy || !inspected || !!binding?.assignment} onClick={() => recover.mutate()}>{t("clear_recovery_hold_8001f7f")}</Button>
      <p className="text-xs text-muted-foreground">{t("this_records_your_inspection_it_does_not_911ed78")}</p>
    </div>}
    {binding?.connected && <Button variant="outline" disabled={busy} onClick={() => disconnect.mutate()}>{t("disconnect_agent_access_8c30a16")}</Button>}
  </section>;
}
