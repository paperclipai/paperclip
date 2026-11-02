import { t, useTranslation } from "@/i18n";
import { useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { Button } from "@/components/ui/button";
import { VoiceCallContext } from "./VoiceCallContext";
import { NativeVoiceConversation } from "./NativeVoiceConversation";

export function TaskVoiceLauncher({ companyId, issueId, agentId, boundEndpointId }: { companyId: string; issueId: string; agentId?: string | null; boundEndpointId?: string }) {
  useTranslation();
  const launcher = useRef<HTMLButtonElement>(null), restoreFocus = useRef(false);
  const host = useContext(VoiceCallContext), previouslyActive = useRef(false);
  const { enabled } = useChatConnectorsEnabled();
  const [open, setOpen] = useState(false), [selected, setSelected] = useState("");
  const connections = useQuery({ queryKey: queryKeys.chatEndpoints.list(companyId), queryFn: () => chatEndpointsApi.list(companyId), enabled: enabled && Boolean(agentId || boundEndpointId) });
  useEffect(() => {
    if (previouslyActive.current && !host?.active && open) { setOpen(false); restoreFocus.current = true; }
    previouslyActive.current = Boolean(host?.active);
  }, [host?.active, open]);
  useEffect(() => {
    if (restoreFocus.current && !connections.isFetching && !connections.isError && launcher.current) {
      restoreFocus.current = false; launcher.current.focus();
    }
  }, [connections.data, connections.isFetching, connections.isError, open]);
  if (!enabled) return null;
  const candidates = (connections.data ?? []).filter((endpoint) => endpoint.provider === "speko" && endpoint.status === "active" && (boundEndpointId ? endpoint.id === boundEndpointId : endpoint.assignedAgentId === agentId));
  const endpoint = candidates.find((entry) => entry.id === selected) ?? candidates[0];
  const connectionError = connections.isError ? <div role="alert" className="space-y-2 text-sm">
    <p>{t("oct19Voice.voiceConnectionsCouldNotBeLoaded_1l5yqn0")}</p>
    <Button variant="outline" disabled={connections.isFetching} onClick={() => { restoreFocus.current = true; void connections.refetch().then(result => { if (result.isError) restoreFocus.current = false; }); }}>{t("oct19Voice.retryVoiceConnections_tv7fd2")}</Button>
  </div> : null;
  if (!endpoint && connectionError) return <section aria-label={t("oct19Voice.taskVoiceConversation_1r82z6h")} className="space-y-3 rounded-lg border border-border p-4">{connectionError}</section>;
  if (!endpoint) return boundEndpointId ? <p className="text-sm text-muted-foreground">{connections.isPending ? t("oct19Voice.loadingVoiceConnection_1grinvr") : t("oct19Voice.voiceIsUnavailableCheckTheSpeko_cqs0nz")}</p> : null;
  return <section aria-label={t("oct19Voice.taskVoiceConversation_1r82z6h")} className="space-y-3 rounded-lg border border-border p-4">
    {connectionError}
    {!open ? <div className="flex flex-wrap items-center gap-3">
      {candidates.length > 1 && <label className="flex min-w-0 max-w-full flex-col gap-2 text-sm">{t("oct19Voice.voicePersona_1jn391")}<select aria-label={t("oct19Voice.voicePersona_1jn391")} className="w-full min-w-0 max-w-full rounded-md border border-input bg-background p-2 text-sm" value={endpoint.id} onChange={(event) => setSelected(event.target.value)}>{candidates.map((entry) => <option key={entry.id} value={entry.id}>{entry.botLabel ?? entry.assignedAgentName}</option>)}</select></label>}
      <Button ref={launcher} variant="outline" onClick={() => setOpen(true)}>{t("oct19Voice.talkTo", { name: endpoint.assignedAgentName })}</Button>
    </div> : <NativeVoiceConversation key={`${companyId}:${issueId}:${endpoint.id}`} companyId={companyId} endpointId={endpoint.id} issueId={issueId} agentName={endpoint.assignedAgentName} />}
  </section>;
}
