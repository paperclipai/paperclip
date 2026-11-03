import { externalRunnerStatusLabel } from "@/lib/external-runner-labels";
import { Trans } from "react-i18next";
import { i18n, t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Button } from "./ui/button";
import { buildDotSetupPrompt } from "../lib/dot-setup-prompt";
import { AgentSetupPrompt } from "./AgentSetupPrompt";

interface Connection {
  enabled: boolean;
  resourceUrl: string | null;
  binding: { id: string; status: string; connected: boolean; subscriptionVerified: boolean; hasPendingChallenge: boolean;
    assignment?: { status: string; attentionRequired: boolean } | null } | null;
}

/** Pairing codes stay in component memory and expire; never save them in config. */
export function DotRunnerConnection({ companyId, agentId, bindingId, onBinding }: {
  companyId?: string; agentId?: string; bindingId?: string; onBinding: (id: string) => void;
}) {
  useTranslation();
  const client = useQueryClient();
  const [pairing, setPairing] = useState<{ pairingCode: string; expiresAt: string } | null>(null);
  const path = `/companies/${companyId}/agents/${agentId}/dot-binding`;
  const key = ["dot-binding", companyId, agentId];
  const state = useQuery({ queryKey: key, enabled: !!companyId && !!agentId,
    queryFn: () => api.get<Connection>(path),
    refetchInterval: query => query.state.data?.binding?.status === "pairing" ||
      (query.state.data?.binding?.connected && !query.state.data.binding.subscriptionVerified) ||
      query.state.data?.binding?.hasPendingChallenge || query.state.data?.binding?.assignment ? 5000 : false });
  const pair = useMutation({ mutationFn: () => api.post<{ bindingId: string; pairingCode: string; expiresAt: string }>(path, {}),
    onSuccess: result => { setPairing(result); onBinding(result.bindingId); void client.invalidateQueries({ queryKey: key }); } });
  const test = useMutation({ mutationFn: () => api.post(path + "/event-test", {}),
    onSuccess: () => { void client.invalidateQueries({ queryKey: key }); } });
  const revoke = useMutation({ mutationFn: () => api.delete(path),
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<Connection>(key, previous => previous ? { ...previous, binding: null } : previous);
      setPairing(null); onBinding("");
      await client.invalidateQueries({ queryKey: key });
    } });
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => setPairing(null), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);
  const existingBindingId = state.data?.binding?.id;
  useEffect(() => {
    if (existingBindingId && existingBindingId !== bindingId && !revoke.isPending) onBinding(existingBindingId);
  }, [existingBindingId, bindingId, onBinding, revoke.isPending]);
  if (!agentId) return <p className="text-sm text-muted-foreground">{t("oct19Voice.saveTheAgentThenReturnHere_1bsme90")}</p>;
  const error = state.error ?? pair.error ?? test.error ?? revoke.error;
  const b = state.data?.binding;
  const setupPrompt = pairing && state.data?.resourceUrl && companyId && agentId
    ? buildDotSetupPrompt({ companyId, agentId, resourceUrl: state.data.resourceUrl, ...pairing })
    : "";
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{t("oct19Voice.dotManagesItsModelAndExternal_qz8g2v")}</p>
    {state.data && !state.data.enabled && <p className="text-sm text-muted-foreground">{t("oct19Voice.enableOpenaiDotAndAssistantConnections_hm7nwm")}</p>}
    {state.data?.resourceUrl && <p className="text-sm break-all"><Trans i18nKey="oct19Voice.privateMcpUrl" values={{ url: state.data.resourceUrl }} components={{ code: <code /> }} /></p>}
    {b && <p className="text-sm">{t("oct19Voice.dotConnection", { status: externalRunnerStatusLabel(b.status), subscription: t(b.subscriptionVerified ? "oct19Voice.verified" : "oct19Voice.required") })}</p>}
    {b?.assignment && <p className="text-sm">{t(b.assignment.status === "offered" ? "oct19Voice.dotAssignmentOffered" : "oct19Voice.dotAssignmentAccepted")}</p>}
    {b?.assignment?.attentionRequired && <p className="text-sm text-destructive" role="alert">{t("oct19Voice.dotHasNotReportedUsefulActivity_1bt7gz1")}</p>}
    {pairing && setupPrompt && b?.status === "pairing" && <div className="space-y-2">
      <AgentSetupPrompt
        prompt={setupPrompt}
        label={t("oct19Voice.setUpWithDot_2dai7f")}
        agent={{ name: "Dot", src: "/brands/adapters/openai-dot.svg" }}
        title={t("oct19Voice.connectYourDot_1qss09r")}
        description={t("oct19Voice.pasteIntoYourDotToConnect_yd1f98")}
        side="bottom"
      />
      <p className="text-xs text-muted-foreground">{t("oct19Voice.setupExpires", { time: new Date(pairing.expiresAt).toLocaleTimeString(i18n.resolvedLanguage) })}</p>
    </div>}
    {!pairing && b?.status === "pairing" && <p className="text-sm text-muted-foreground">{t("oct19Voice.revokeThePendingConnectionAndPair_zjedca")}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {!b && <Button type="button" variant="outline" disabled={!state.data?.enabled || !state.data?.resourceUrl || pair.isPending} onClick={() => pair.mutate()}>{t("oct19Voice.pairDot_17y701q")}</Button>}
      {b?.subscriptionVerified && <Button type="button" variant="outline" disabled={test.isPending || b.hasPendingChallenge} onClick={() => test.mutate()}>{t("oct19Voice.testEventDelivery_e56rnb")}</Button>}
      <Button type="button" variant="outline" onClick={() => { void state.refetch(); }}>{t("oct19Voice.refreshConnection_7d3lxo")}</Button>
      {b && <Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>{t("oct19Voice.revokeConnection_1mj9ckl")}</Button>}
    </div>
    {b?.hasPendingChallenge && <p className="text-sm text-muted-foreground">{t("oct19Voice.waitingForDotToReadAnd_gkrw3x")}</p>}
    {error && <p className="text-sm text-destructive" role="alert">{error instanceof Error ? error.message : t("oct19Voice.connectionFailed_1zoa0m")}</p>}
  </div>;
}
