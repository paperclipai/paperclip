import { useTranslation, t as translate } from "@/i18n";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { VoiceCallHistoryEntry, VoiceCallReport, VoiceUnapprovedCallHistoryEntry } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { voiceSessionsApi } from "@/api/voiceSessions";
import { voicePhoneApi } from "@/api/voicePhone";
import { voiceHistoryApi } from "@/api/voiceHistory";

function charge(amount: string | null) {
  if (amount === null) return translate("connections:not_yet_reported_d64fc25");
  const value = BigInt(amount);
  const whole = value / 1_000_000n, fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return translate("connections:usd_ec3f1c4", { whole: whole, fraction: fraction });
}
export function SpekoCallReport({ report }: { report: VoiceCallReport }) {
  const { t } = useTranslation("connections");
  return <div className="space-y-3">
    <dl className="flex flex-wrap gap-4 text-sm"><div><dt className="text-muted-foreground">{t("speko_charge_17e0ac2")}</dt><dd>{charge(report.costMicroUsd)}</dd></div>{report.durationSeconds !== null && <div><dt className="text-muted-foreground">{t("duration_1370004")}</dt><dd>{t("final-components-b:count_seconds_ac39ac", { count: report.durationSeconds })}</dd></div>}</dl>
    <p className="text-xs text-muted-foreground">{t("agent_costs_are_separate_recordings_remain_in_270ede3")}</p>
    {report.transcript.length ? <ol aria-label={t("call_transcript_2e3a926")} className="space-y-3">{report.transcript.map(turn => <li key={turn.id} className="min-w-0"><p className="text-xs font-medium text-muted-foreground">{turn.speaker === "caller" ? t("you_905cb32") : t("agent_5ce2e6f")}{turn.interrupted ? t("interrupted_9cf4e0b") : ""}</p><p className="whitespace-pre-wrap break-words text-sm">{turn.text}</p></li>)}</ol>
      : <p className="text-sm text-muted-foreground">{report.status === "unavailable" ? t("the_transcript_is_unavailable_paperclip_will_retry_5384382") : report.status === "pending" ? t("the_transcript_will_appear_after_speko_finishes_544065a") : t("speko_did_not_provide_a_transcript_for_eafc4c3")}</p>}
  </div>;
}
const modeNames = { get browser() { return translate("connections:browser_voice_4543e66"); }, get inbound_phone() { return translate("connections:incoming_call_7af30b7"); }, get outbound_phone() { return translate("connections:outgoing_call_27a2371"); } } as const;
const stateNames = { get reserved() { return translate("connections:preparing_96a9b7c"); }, get creating() { return translate("connections:connecting_c1f3b71"); }, get creation_unknown() { return translate("connections:checking_connection_b54eddd"); }, get connecting() { return translate("connections:connecting_c1f3b71"); }, get active() { return translate("connections:in_progress_b6bd42e"); }, get awaiting_approval() { return translate("connections:awaiting_approval_d0a0d80"); }, get ending() { return translate("connections:ending_89a8a63"); }, get ended() { return translate("connections:completed_1798b3b"); }, get failed() { return translate("connections:failed_09fef5d"); }, get expired() { return translate("connections:expired_a689a99"); } } as const;
export function SpekoCallActivityItem({ entry: { session, report }, onEnd, ending, presentation = "history" }: { entry: VoiceCallHistoryEntry; onEnd?(sessionId: string): void; ending?: boolean; presentation?: "history" | "activity" }) {
  const { t } = useTranslation("connections");
  const summary = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (restoreFocus.current && ["ended", "failed", "expired"].includes(session.state)) { summary.current?.focus(); restoreFocus.current = false; }
  }, [session.state]);
  return <details data-activity-kind="call" className={presentation === "activity" ? "px-2 py-3 transition-colors hover:bg-accent/50" : "rounded-md border border-border p-3"}>
    <summary ref={summary} className="cursor-pointer break-words text-sm font-medium">{modeNames[session.mode]} · {stateNames[session.state]}<span className="ml-2 text-xs font-normal text-muted-foreground">{new Date(session.createdAt).toLocaleString()}</span></summary>
    <div className="mt-3 space-y-3"><Link className="text-sm text-primary underline" to={`/issues/${encodeURIComponent(session.issueId)}`}>{t("conversation_task_3204e34")}</Link>
      {session.errorCode && <p className="text-sm text-muted-foreground">{session.errorCode === "cleanup_pending" ? t("confirming_call_cleanup_with_speko_74613ec") : t("this_call_encountered_a_connection_problem_check_666ec41")}</p>}
      {!session.endedAt && !["ended", "failed", "expired"].includes(session.state) && session.callerAuthority !== "guest_intake" && onEnd && <Button size="sm" variant="outline" disabled={ending} onClick={() => { restoreFocus.current = true; onEnd(session.id); }}>{ending ? t("ending_aab85fb") : t("end_call_c8de761")}</Button>}
      <SpekoCallReport report={report} />
    </div>
  </details>;
}
export function SpekoUnapprovedCallActivityItem({ call, presentation = "history" }: { call: VoiceUnapprovedCallHistoryEntry; presentation?: "history" | "activity" }) {
  const { t } = useTranslation("connections");
  return <div data-activity-kind="unapproved_call" className={presentation === "activity" ? "px-2 py-3 text-sm" : "rounded-md border border-border p-3 text-sm"}><p>{call.state === "denied" ? t("call_denied_56c417b") : call.state === "expired" ? t("approval_expired_29ce950") : t("missed_call_0200c29")} · {new Date(call.createdAt).toLocaleString()}</p><p className="text-xs text-muted-foreground">{t("no_private_task_was_connected_5dcf2aa")}</p></div>;
}
export interface SpekoCallHistoryViewProps { entries?: VoiceCallHistoryEntry[]; unapprovedCalls?: VoiceUnapprovedCallHistoryEntry[]; loading?: boolean; error?: string; incomingError?: string; endError?: string; onRetry(): void; onEnd?(sessionId: string): void; endingSessionId?: string }
export function SpekoCallHistoryView({ entries = [], unapprovedCalls = [], loading, error, incomingError, endError, onRetry, onEnd, endingSessionId }: SpekoCallHistoryViewProps) {
  const { t } = useTranslation("connections");
  return <section className="max-w-xl space-y-3" aria-label={t("your_calls_0888104")}>
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t("your_calls_0888104")}</h2><Button size="sm" variant="ghost" onClick={onRetry} disabled={loading}>{t("refresh_56e3bad")}</Button></div>
    {loading && <p role="status" className="text-sm text-muted-foreground">{t("loading_calls_3328f74")}</p>}
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={onRetry}>{t("try_again_042c862")}</Button></div>}
    {incomingError && <p role="alert" className="text-sm text-destructive">{t("unapproved_calls_could_not_be_loaded_6978fd4", { incomingError: incomingError })}</p>}
    {endError && <p role="alert" className="text-sm text-destructive">{t("the_call_could_not_be_ended_1e3c809", { endError: endError })}</p>}
    {!loading && !error && !incomingError && !entries.length && !unapprovedCalls.length && <p className="text-sm text-muted-foreground">{t("your_browser_conversations_and_phone_calls_will_f51a7a5")}</p>}
    {!error && entries.map(entry => <SpekoCallActivityItem key={entry.session.id} entry={entry} onEnd={onEnd} ending={endingSessionId === entry.session.id} />)}
    {!incomingError && unapprovedCalls.length > 0 && <div className="space-y-2"><h3 className="text-sm font-medium">{t("unapproved_incoming_calls_29156d1")}</h3><ul className="space-y-2">{unapprovedCalls.map(call => <li key={call.id}><SpekoUnapprovedCallActivityItem call={call} /></li>)}</ul></div>}
  </section>;
}
export function useSpekoCallHistory(companyId: string, endpointId: string, enabled = true) {
  const query = useQuery({ queryKey: ["speko-history", companyId, endpointId], queryFn: () => voiceHistoryApi.list(companyId, endpointId), enabled, refetchInterval: enabled ? 30_000 : false });
  const incoming = useQuery({queryKey: ["speko-unapproved-history", companyId, endpointId], queryFn: () => voicePhoneApi.history(companyId, endpointId), enabled: enabled && query.isSuccess, refetchInterval: enabled ? 30_000 : false});
  const ending = useMutation({mutationFn: (sessionId: string) => voiceSessionsApi.end(companyId, sessionId), onSuccess: () => query.refetch()});
  return { entries: query.data ?? [], unapprovedCalls: incoming.data ?? [], loading: query.isLoading || incoming.isLoading, error: query.error?.message, incomingError: incoming.error?.message, endError: ending.error?.message, endingSessionId: ending.isPending ? ending.variables : undefined,
    onEnd: (sessionId: string) => ending.mutate(sessionId), onRetry: () => { ending.reset(); void query.refetch(); void incoming.refetch(); } };
}
export function SpekoCallHistory({ companyId, endpointId }: { companyId: string; endpointId: string }) {
  return <SpekoCallHistoryView {...useSpekoCallHistory(companyId, endpointId)} />;
}
