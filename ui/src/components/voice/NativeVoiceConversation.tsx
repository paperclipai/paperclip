import { useTranslation } from "@/i18n";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { voiceSessionsApi } from "@/api/voiceSessions";
import { Button } from "@/components/ui/button";
import { VoiceCallContext } from "./VoiceCallContext";
import { Link } from "react-router-dom";
import { ApiError } from "@/api/client";
import { connectSpekoVoiceMedia } from "@/lib/speko-voice-media";
import { createVoiceCallAttempt, type VoiceCallJournal } from "@/lib/voice-call-attempt";
import { VoiceConversationPanel } from "./VoiceConversationPanel";

export interface NativeVoiceConversationProps {
  companyId: string;
  endpointId: string;
  issueId?: string;
  managed?: boolean;
  autoStart?: boolean;
  newConversation?: boolean;
  onEndedChange?: (ended: boolean) => void;
  journal?: VoiceCallJournal;
  agentName: string;
  /** Story fixtures replace the external client and media, never the component. */
  client?: typeof voiceSessionsApi;
  connect?: typeof connectSpekoVoiceMedia;
}

export function NativeVoiceConversation(props: NativeVoiceConversationProps) {
  const { t } = useTranslation("connections");
  const host = useContext(VoiceCallContext);
  const [newConversation, setNewConversation] = useState(false);
  if (host && !props.managed) return <div className="flex flex-col gap-2">
    {!props.issueId && <ConversationChoice value={newConversation} disabled={host.active} onChange={setNewConversation} />}
    <Button size="sm" variant="outline" disabled={host.active} onClick={() => host.open({ ...props, newConversation })}>{host.active ? t("voice_panel_open_13c4012") : t("start_voice_cc778bf")}</Button>
  </div>;
  return <VoiceSessionView {...props} />;
}

function ConversationChoice({ value, disabled, onChange }: { value: boolean; disabled: boolean; onChange(value: boolean): void }) {
  const { t } = useTranslation("connections");
  return <label className="flex flex-col gap-2 text-sm">{t("conversation_0511671")}<select disabled={disabled} aria-label={t("conversation_2a20c75")} className="rounded-md border border-input bg-background p-2 text-sm" value={value ? "new" : "continue"} onChange={event => onChange(event.target.value === "new")}><option value="continue">{t("continue_conversation_577225a")}</option><option value="new">{t("new_conversation_7f031b1")}</option></select>
  </label>;
}

export function VoiceSessionView({ companyId, endpointId, issueId, agentName, autoStart, newConversation: initialNewConversation = false, onEndedChange, journal, client = voiceSessionsApi, connect = connectSpekoVoiceMedia }: NativeVoiceConversationProps) {
  const { t } = useTranslation("connections");
  const [sessionId, setSessionId] = useState<string>();
  const [boundIssueId, setBoundIssueId] = useState(issueId);
  const [starting, setStarting] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const [newConversation, setNewConversation] = useState(initialNewConversation);
  const intent = useRef(newConversation);
  intent.current = newConversation;
  const dependencies = useMemo(() => {
    const attempt = createVoiceCallAttempt(companyId, client, journal);
    return {
      async mint() {
        setAccessLost(false); setStarting(true);
        try {
          const result = await attempt.start({ endpointId, issueId, ...(intent.current ? { newConversation: true } : {}) });
          setSessionId(result.session.id); setBoundIssueId(result.session.issueId);
          return result.media;
        } finally { setStarting(false); }
      },
      async end(id: string) {
        await attempt.end(id);
        setSessionId(undefined); setNewConversation(false);
      },
      connect,
    };
  }, [companyId, endpointId, issueId, client, connect, journal]);
  const notification = useQuery({
    queryKey: ["voice-notification", companyId, sessionId],
    queryFn: () => client.notification(companyId, sessionId!),
    enabled: Boolean(sessionId),
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
    });
  const rejected = notification.error instanceof ApiError && [401, 403, 404].includes(notification.error.status);
  useEffect(() => { if (rejected) setAccessLost(true); }, [rejected]);
  const accessRevoked = rejected || accessLost;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!issueId && !sessionId && !autoStart && <ConversationChoice value={newConversation} disabled={starting} onChange={setNewConversation} />}
      {boundIssueId && <Link className="text-sm text-primary underline" to={`/issues/${encodeURIComponent(boundIssueId)}`}>{t("view_conversation_task_a26d6ab")}</Link>}
      <VoiceConversationPanel agentName={agentName} autoStart={autoStart} accessRevoked={accessRevoked} onEndedChange={onEndedChange} dependencies={dependencies} notification={notification.data ?? undefined} />
      {(notification.isError || accessLost) && <p role="alert" className="text-sm text-destructive">{accessRevoked ? t("access_to_this_call_is_no_longer_39c3a72") : t("task_updates_are_temporarily_unavailable_the_connection_4cb2625")}</p>}
      <p className="text-xs text-muted-foreground">{t("speko_handles_the_audio_and_may_retain_e150ec2")}</p>
    </div>
  );
}
