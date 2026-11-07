import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { describeError } from "../api/errors";
import { Button } from "./ui/button";
import { buildDotSetupPrompt } from "../lib/dot-setup-prompt";
import { AgentSetupPrompt } from "./AgentSetupPrompt";
import { QueryErrorState, useQueryView } from "./QueryView";

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
  const { t } = useTranslation("connections");
  const client = useQueryClient();
  const [pairing, setPairing] = useState<{ pairingCode: string; expiresAt: string } | null>(null);
  const path = `/companies/${companyId}/agents/${agentId}/dot-binding`;
  const key = ["dot-binding", companyId, agentId];
  const state = useQuery({ queryKey: key, enabled: !!companyId && !!agentId,
    queryFn: () => api.get<Connection>(path),
    refetchInterval: query => query.state.data?.binding?.status === "pairing" ||
      (query.state.data?.binding?.connected && !query.state.data.binding.subscriptionVerified) ||
      query.state.data?.binding?.hasPendingChallenge || query.state.data?.binding?.assignment ? 5000 : false });
  // Read the connection state through the shared view: cached data stays
  // visible while a transient refetch fails,and a no-data failure shows
  // readable copy with Retry.
  const stateView = useQueryView(state);
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
  if (!agentId) return <p className="text-sm text-muted-foreground">{t("save_the_agent_then_return_here_to_34c9a5d")}</p>;
  const mutationError = pair.error ?? test.error ?? revoke.error;
  const b = state.data?.binding;
  const setupPrompt = pairing && state.data?.resourceUrl && companyId && agentId
    ? buildDotSetupPrompt({ companyId, agentId, resourceUrl: state.data.resourceUrl, ...pairing })
    : "";
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{t("dot_manages_its_model_and_external_tools_64ed9e1")}</p>
    {state.data && !state.data.enabled && <p className="text-sm text-muted-foreground">{t("enable_openai_dot_and_assistant_connections_mcp_b4d6bb4")}</p>}
    {state.data?.resourceUrl && <p className="text-sm break-all">{t("private_plugin_mcp_url_fd23387")}<code>{state.data.resourceUrl}</code></p>}
    {b && <p className="text-sm">{t("connection_eeb4784")}{b.status}{t("event_subscription_1f3d5c5")}{b.subscriptionVerified ? t("final-components-a:verified_1c34f887") : t("final-components-a:required_d0a36305")}.</p>}
    {b?.assignment && <p className="text-sm">{t("assignment_fb694c7")}{b.assignment.status === "offered" ? t("waiting_for_dot_to_accept_f750c4f") : t("accepted_by_dot_6290c22")}.</p>}
    {b?.assignment?.attentionRequired && <p className="text-sm text-destructive" role="alert">{t("dot_has_not_reported_useful_activity_for_f658aef")}</p>}
    {pairing && setupPrompt && b?.status === "pairing" && <div className="space-y-2">
      <AgentSetupPrompt
        prompt={setupPrompt}
        label={t("set_up_with_dot_e6ac096")}
        agent={{ name: "Dot", src: "/brands/adapters/openai-dot.svg" }}
        title={t("connect_your_dot_d7cfc6a")}
        description={t("paste_into_your_dot_to_connect_this_858acd0")}
        side="bottom"
      />
      <p className="text-xs text-muted-foreground">{t("setup_prompt_expires_0725ffd", { value: new Date(pairing.expiresAt).toLocaleTimeString() })}</p>
    </div>}
    {!pairing && b?.status === "pairing" && <p className="text-sm text-muted-foreground">{t("revoke_the_pending_connection_and_pair_again_5b9e179")}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {!b && <Button type="button" variant="outline" disabled={!state.data?.enabled || !state.data?.resourceUrl || pair.isPending} onClick={() => pair.mutate()}>{t("pair_dot_2947908")}</Button>}
      {b?.subscriptionVerified && <Button type="button" variant="outline" disabled={test.isPending || b.hasPendingChallenge} onClick={() => test.mutate()}>{t("test_event_delivery_823e325")}</Button>}
      <Button type="button" variant="outline" onClick={() => { void state.refetch(); }}>{t("refresh_connection_e260210")}</Button>
      {b && <Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>{t("revoke_connection_d6f480f")}</Button>}
    </div>
    {b?.hasPendingChallenge && <p className="text-sm text-muted-foreground">{t("waiting_for_dot_to_read_and_confirm_edb996a")}</p>}
    {stateView.kind === "error" && (
      <QueryErrorState
        size="inline"
        error={stateView.error}
        action="load the Dot connection"
        onRetry={stateView.retry}
        retrying={stateView.isFetching}
      />
    )}
    {mutationError && <p role="alert" className="text-sm text-destructive">{describeError(mutationError).body}</p>}
  </div>;
}
