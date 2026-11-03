import { i18n, t, useTranslation } from "@/i18n";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { VoiceCallHistoryEntry, VoiceCallReport, VoiceUnapprovedCallHistoryEntry } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { voiceSessionsApi } from "@/api/voiceSessions";
import { voicePhoneApi } from "@/api/voicePhone";
import { voiceHistoryApi } from "@/api/voiceHistory";

function charge(amount: string | null) {
  if (amount === null) return t("oct19Voice.notYetReported_1pn5nb");
  const value = BigInt(amount);
  const whole = value / 1_000_000n, fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `$${whole}.${fraction} USD`;
}
export function SpekoCallReport({ report }: { report: VoiceCallReport }) {
  useTranslation();
  return <div className="space-y-3">
    <dl className="flex flex-wrap gap-4 text-sm"><div><dt className="text-muted-foreground">{t("oct19Voice.spekoCharge_gr6zlp")}</dt><dd>{charge(report.costMicroUsd)}</dd></div>{report.durationSeconds !== null && <div><dt className="text-muted-foreground">{t("oct19Voice.duration_1n1dulp")}</dt><dd>{t("oct19Voice.duration", { count: report.durationSeconds })}</dd></div>}</dl>
    <p className="text-xs text-muted-foreground">{t("oct19Voice.agentCostsAreSeparateRecordingsRemain_kywz34")}</p>
    {report.transcript.length ? <ol aria-label={t("oct19Voice.callTranscript_7fx171")} className="space-y-3">{report.transcript.map(turn => <li key={turn.id} className="min-w-0"><p className="text-xs font-medium text-muted-foreground">{turn.speaker === "caller" ? t("oct19Voice.you_1efd4xo") : t("oct19Voice.agent_1w5o8jq")}{turn.interrupted ? t("oct19Voice.interrupted_1o1ooqy") : ""}</p><p className="whitespace-pre-wrap break-words text-sm">{turn.text}</p></li>)}</ol>
      : <p className="text-sm text-muted-foreground">{report.status === "unavailable" ? t("oct19Voice.theTranscriptIsUnavailablePaperclipWill_1o3xmcn") : report.status === "pending" ? t("oct19Voice.theTranscriptWillAppearAfterSpeko_14xpoip") : t("oct19Voice.spekoDidNotProvideATranscript_2esv38")}</p>}
  </div>;
}
const modeNames = () => ({  browser: t("oct19Voice.browserVoice_742sn5"), inbound_phone: t("oct19Voice.incomingCall_t6d2pn"), outbound_phone: t("oct19Voice.outgoingCall_1mqbrfp") } as const);
const stateNames = () => ({  reserved: t("oct19Voice.preparing_16drz3j"), creating: t("oct19Voice.connecting_dkiton"), creation_unknown: t("oct19Voice.checkingConnection_1rumur7"), connecting: t("oct19Voice.connecting_dkiton"), active: t("oct19Voice.inProgress_bgdh5x"), awaiting_approval: t("oct19Voice.awaitingApproval_16n26pe"), ending: t("oct19Voice.ending_pakdrq"), ended: t("oct19Voice.completed_1tmo59u"), failed: t("oct19Voice.failed_npsixg"), expired: t("oct19Voice.expired_1gcie36") } as const);
export function SpekoCallActivityItem({ entry: { session, report }, onEnd, ending, presentation = "history" }: { entry: VoiceCallHistoryEntry; onEnd?(sessionId: string): void; ending?: boolean; presentation?: "history" | "activity" }) {
  useTranslation();
  const summary = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (restoreFocus.current && ["ended", "failed", "expired"].includes(session.state)) { summary.current?.focus(); restoreFocus.current = false; }
  }, [session.state]);
  return <details data-activity-kind="call" className={presentation === "activity" ? "px-2 py-3 transition-colors hover:bg-accent/50" : "rounded-md border border-border p-3"}>
    <summary ref={summary} className="cursor-pointer break-words text-sm font-medium">{modeNames()[session.mode]} · {stateNames()[session.state]}<span className="ml-2 text-xs font-normal text-muted-foreground">{new Date(session.createdAt).toLocaleString(i18n.resolvedLanguage)}</span></summary>
    <div className="mt-3 space-y-3"><Link className="text-sm text-primary underline" to={`/issues/${encodeURIComponent(session.issueId)}`}>{t("oct19Voice.conversationTask_1wckt7j")}</Link>
      {session.errorCode && <p className="text-sm text-muted-foreground">{session.errorCode === "cleanup_pending" ? t("oct19Voice.confirmingCallCleanupWithSpeko_d3jo9p") : t("oct19Voice.thisCallEncounteredAConnectionProblem_1eph65e")}</p>}
      {!session.endedAt && !["ended", "failed", "expired"].includes(session.state) && session.callerAuthority !== "guest_intake" && onEnd && <Button size="sm" variant="outline" disabled={ending} onClick={() => { restoreFocus.current = true; onEnd(session.id); }}>{ending ? t("oct19Voice.ending_4ua7jk") : t("oct19Voice.endCall_ac9342")}</Button>}
      <SpekoCallReport report={report} />
    </div>
  </details>;
}
export function SpekoUnapprovedCallActivityItem({ call, presentation = "history" }: { call: VoiceUnapprovedCallHistoryEntry; presentation?: "history" | "activity" }) {
  useTranslation();
  return <div data-activity-kind="unapproved_call" className={presentation === "activity" ? "px-2 py-3 text-sm" : "rounded-md border border-border p-3 text-sm"}><p>{call.state === "denied" ? t("oct19Voice.callDenied_1jpfg54") : call.state === "expired" ? t("oct19Voice.approvalExpired_1j4mulv") : t("oct19Voice.missedCall_18wd06o")} · {new Date(call.createdAt).toLocaleString(i18n.resolvedLanguage)}</p><p className="text-xs text-muted-foreground">{t("oct19Voice.noPrivateTaskWasConnected_g1eu26")}</p></div>;
}
export interface SpekoCallHistoryViewProps { entries?: VoiceCallHistoryEntry[]; unapprovedCalls?: VoiceUnapprovedCallHistoryEntry[]; loading?: boolean; error?: string; incomingError?: string; endError?: string; onRetry(): void; onEnd?(sessionId: string): void; endingSessionId?: string }
export function SpekoCallHistoryView({ entries = [], unapprovedCalls = [], loading, error, incomingError, endError, onRetry, onEnd, endingSessionId }: SpekoCallHistoryViewProps) {
  useTranslation();
  return <section className="max-w-xl space-y-3" aria-label={t("oct19Voice.yourCalls_13mhtgj")}>
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t("oct19Voice.yourCalls_13mhtgj")}</h2><Button size="sm" variant="ghost" onClick={onRetry} disabled={loading}>{t("oct19Voice.refresh_28r6qc")}</Button></div>
    {loading && <p role="status" className="text-sm text-muted-foreground">{t("oct19Voice.loadingCalls_1fo8j2g")}</p>}
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={onRetry}>{t("oct19Voice.tryAgain_982hh6")}</Button></div>}
    {incomingError && <p role="alert" className="text-sm text-destructive">{t("oct19Voice.unapprovedCallsCouldNotBeLoaded_1yqx89c")} {incomingError}</p>}
    {endError && <p role="alert" className="text-sm text-destructive">{t("oct19Voice.theCallCouldNotBeEnded_zk6slt")} {endError}</p>}
    {!loading && !error && !incomingError && !entries.length && !unapprovedCalls.length && <p className="text-sm text-muted-foreground">{t("oct19Voice.yourBrowserConversationsAndPhoneCalls_1m3sznv")}</p>}
    {!error && entries.map(entry => <SpekoCallActivityItem key={entry.session.id} entry={entry} onEnd={onEnd} ending={endingSessionId === entry.session.id} />)}
    {!incomingError && unapprovedCalls.length > 0 && <div className="space-y-2"><h3 className="text-sm font-medium">{t("oct19Voice.unapprovedIncomingCalls_dgxa4e")}</h3><ul className="space-y-2">{unapprovedCalls.map(call => <li key={call.id}><SpekoUnapprovedCallActivityItem call={call} /></li>)}</ul></div>}
  </section>;
}
export function useSpekoCallHistory(companyId: string, endpointId: string, enabled = true) {
  const query = useQuery({ queryKey: ["speko-history", companyId, endpointId], queryFn: () => voiceHistoryApi.list(companyId, endpointId), enabled, retry: false, refetchInterval: enabled ? 30_000 : false });
  const incoming = useQuery({queryKey: ["speko-unapproved-history", companyId, endpointId], queryFn: () => voicePhoneApi.history(companyId, endpointId), retry: false, enabled: enabled && query.isSuccess, refetchInterval: enabled ? 30_000 : false});
  const ending = useMutation({mutationFn: (sessionId: string) => voiceSessionsApi.end(companyId, sessionId), onSuccess: () => query.refetch()});
  return { entries: query.data ?? [], unapprovedCalls: incoming.data ?? [], loading: query.isLoading || incoming.isLoading, error: query.error?.message, incomingError: incoming.error?.message, endError: ending.error?.message, endingSessionId: ending.isPending ? ending.variables : undefined,
    onEnd: (sessionId: string) => ending.mutate(sessionId), onRetry: () => { ending.reset(); void query.refetch(); void incoming.refetch(); } };
}
export function SpekoCallHistory({ companyId, endpointId }: { companyId: string; endpointId: string }) {
  useTranslation();
  return <SpekoCallHistoryView {...useSpekoCallHistory(companyId, endpointId)} />;
}
