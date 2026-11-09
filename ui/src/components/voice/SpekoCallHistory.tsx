import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { VoiceCallHistoryEntry, VoiceCallReport, VoiceUnapprovedCallHistoryEntry } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { voiceSessionsApi } from "@/api/voiceSessions";
import { voicePhoneApi } from "@/api/voicePhone";
import { voiceHistoryApi } from "@/api/voiceHistory";
import { t, useTranslation } from "@/i18n";

function charge(amount: string | null) {
  if (amount === null) return t("agents.SpekoCallReport.notYetReported");
  const value = BigInt(amount);
  const whole = value / 1_000_000n, fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `$${whole}.${fraction} USD`;
}
export function SpekoCallReport({ report }: { report: VoiceCallReport }) {
  const { t } = useTranslation();
  return <div className="space-y-3">
    <dl className="flex flex-wrap gap-4 text-sm"><div><dt className="text-muted-foreground">{t("agents.SpekoCallReport.charge")}</dt><dd>{charge(report.costMicroUsd)}</dd></div>{report.durationSeconds !== null && <div><dt className="text-muted-foreground">{t("agents.SpekoCallReport.duration")}</dt><dd>{t("agents.SpekoCallReport.durationSeconds", { count: report.durationSeconds })}</dd></div>}</dl>
    <p className="text-xs text-muted-foreground">{t("agents.SpekoCallReport.costsNotice")}</p>
    {report.transcript.length ? <ol aria-label={t("agents.SpekoCallReport.transcriptLabel")} className="space-y-3">{report.transcript.map(turn => <li key={turn.id} className="min-w-0"><p className="text-xs font-medium text-muted-foreground">{turn.speaker === "caller" ? t("agents.SpekoCallReport.you") : t("agents.SpekoCallReport.agent")}{turn.interrupted ? t("agents.SpekoCallReport.interruptedSuffix") : ""}</p><p className="whitespace-pre-wrap break-words text-sm">{turn.text}</p></li>)}</ol>
      : <p className="text-sm text-muted-foreground">{report.status === "unavailable" ? t("agents.SpekoCallReport.transcriptUnavailable") : report.status === "pending" ? t("agents.SpekoCallReport.transcriptPending") : t("agents.SpekoCallReport.transcriptMissing")}</p>}
  </div>;
}
function modeNames() {
  return { browser: t("agents.SpekoCallActivityItem.modeBrowser"), inbound_phone: t("agents.SpekoCallActivityItem.modeInbound"), outbound_phone: t("agents.SpekoCallActivityItem.modeOutbound") } as const;
}
function stateNames() {
  return { reserved: t("agents.SpekoCallActivityItem.stateReserved"), creating: t("agents.SpekoCallActivityItem.stateCreating"), creation_unknown: t("agents.SpekoCallActivityItem.stateCreationUnknown"), connecting: t("agents.SpekoCallActivityItem.stateConnecting"), active: t("agents.SpekoCallActivityItem.stateActive"), awaiting_approval: t("agents.SpekoCallActivityItem.stateAwaitingApproval"), ending: t("agents.SpekoCallActivityItem.stateEnding"), ended: t("agents.SpekoCallActivityItem.stateEnded"), failed: t("agents.SpekoCallActivityItem.stateFailed"), expired: t("agents.SpekoCallActivityItem.stateExpired") } as const;
}
export function SpekoCallActivityItem({ entry: { session, report }, onEnd, ending, presentation = "history" }: { entry: VoiceCallHistoryEntry; onEnd?(sessionId: string): void; ending?: boolean; presentation?: "history" | "activity" }) {
  const { t } = useTranslation();
  const summary = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (restoreFocus.current && ["ended", "failed", "expired"].includes(session.state)) { summary.current?.focus(); restoreFocus.current = false; }
  }, [session.state]);
  return <details data-activity-kind="call" className={presentation === "activity" ? "px-2 py-3 transition-colors hover:bg-accent/50" : "rounded-md border border-border p-3"}>
    <summary ref={summary} className="cursor-pointer break-words text-sm font-medium">{modeNames()[session.mode]} · {stateNames()[session.state]}<span className="ml-2 text-xs font-normal text-muted-foreground">{new Date(session.createdAt).toLocaleString()}</span></summary>
    <div className="mt-3 space-y-3"><Link className="text-sm text-primary underline" to={`/issues/${encodeURIComponent(session.issueId)}`}>{t("agents.SpekoCallActivityItem.conversationTask")}</Link>
      {session.errorCode && <p className="text-sm text-muted-foreground">{session.errorCode === "cleanup_pending" ? t("agents.SpekoCallActivityItem.cleanupPending") : t("agents.SpekoCallActivityItem.connectionProblem")}</p>}
      {!session.endedAt && !["ended", "failed", "expired"].includes(session.state) && session.callerAuthority !== "guest_intake" && onEnd && <Button size="sm" variant="outline" disabled={ending} onClick={() => { restoreFocus.current = true; onEnd(session.id); }}>{ending ? t("agents.SpekoCallActivityItem.ending") : t("agents.SpekoCallActivityItem.endCall")}</Button>}
      <SpekoCallReport report={report} />
    </div>
  </details>;
}
export function SpekoUnapprovedCallActivityItem({ call, presentation = "history" }: { call: VoiceUnapprovedCallHistoryEntry; presentation?: "history" | "activity" }) {
  const { t } = useTranslation();
  return <div data-activity-kind="unapproved_call" className={presentation === "activity" ? "px-2 py-3 text-sm" : "rounded-md border border-border p-3 text-sm"}><p>{call.state === "denied" ? t("agents.SpekoUnapprovedCallActivityItem.denied") : call.state === "expired" ? t("agents.SpekoUnapprovedCallActivityItem.expired") : t("agents.SpekoUnapprovedCallActivityItem.missed")} · {new Date(call.createdAt).toLocaleString()}</p><p className="text-xs text-muted-foreground">{t("agents.SpekoUnapprovedCallActivityItem.noTask")}</p></div>;
}
export interface SpekoCallHistoryViewProps { entries?: VoiceCallHistoryEntry[]; unapprovedCalls?: VoiceUnapprovedCallHistoryEntry[]; loading?: boolean; error?: string; incomingError?: string; endError?: string; onRetry(): void; onEnd?(sessionId: string): void; endingSessionId?: string }
export function SpekoCallHistoryView({ entries = [], unapprovedCalls = [], loading, error, incomingError, endError, onRetry, onEnd, endingSessionId }: SpekoCallHistoryViewProps) {
  const { t } = useTranslation();
  return <section className="max-w-xl space-y-3" aria-label={t("agents.SpekoCallHistoryView.title")}>
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t("agents.SpekoCallHistoryView.title")}</h2><Button size="sm" variant="ghost" onClick={onRetry} disabled={loading}>{t("agents.SpekoCallHistoryView.refresh")}</Button></div>
    {loading && <p role="status" className="text-sm text-muted-foreground">{t("agents.SpekoCallHistoryView.loading")}</p>}
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={onRetry}>{t("agents.SpekoCallHistoryView.tryAgain")}</Button></div>}
    {incomingError && <p role="alert" className="text-sm text-destructive">{t("agents.SpekoCallHistoryView.incomingError", { error: incomingError })}</p>}
    {endError && <p role="alert" className="text-sm text-destructive">{t("agents.SpekoCallHistoryView.endError", { error: endError })}</p>}
    {!loading && !error && !incomingError && !entries.length && !unapprovedCalls.length && <p className="text-sm text-muted-foreground">{t("agents.SpekoCallHistoryView.empty")}</p>}
    {!error && entries.map(entry => <SpekoCallActivityItem key={entry.session.id} entry={entry} onEnd={onEnd} ending={endingSessionId === entry.session.id} />)}
    {!incomingError && unapprovedCalls.length > 0 && <div className="space-y-2"><h3 className="text-sm font-medium">{t("agents.SpekoCallHistoryView.unapprovedHeading")}</h3><ul className="space-y-2">{unapprovedCalls.map(call => <li key={call.id}><SpekoUnapprovedCallActivityItem call={call} /></li>)}</ul></div>}
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
