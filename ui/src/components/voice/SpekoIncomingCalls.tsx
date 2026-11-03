import { t, useTranslation } from "@/i18n";
import { Link } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { VoiceInboundCall } from "@paperclipai/shared";
import { voicePhoneApi } from "@/api/voicePhone";
import { issuesApi } from "@/api/issues";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export interface SpekoIncomingCallCardProps { call: VoiceInboundCall; tasks?: {id: string; label: string}[]; busy?: boolean; error?: string; onDecide(input: {approve: boolean; approvalCode: string; issueId?: string}): void }
export function SpekoIncomingCallCard({call, tasks = [], busy, error, onDecide}: SpekoIncomingCallCardProps) {
  useTranslation();
  const [code, setCode] = useState(""), [issueId, setIssueId] = useState(""), [invalid, setInvalid] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = ["guest_intake", "awaiting_approval", "approving"].includes(call.state);
  useEffect(() => { if (!pending) heading.current?.focus(); }, [pending]);
  if (call.state === "guest_intake") return <section className="max-w-xl space-y-3 rounded-md border border-border p-3" aria-label={t("oct19Voice.incomingConversation_49f644")}>
    <h3 className="text-sm font-semibold">{t("oct19Voice.incomingConversation_49f644")}</h3>
    {call.intakeIssueId && <Link className="text-sm text-primary underline" to={`/issues/${call.intakeIssueId}`}>{t("oct19Voice.openConversationTask_3gzm09")}</Link>}
    <p className="text-sm text-muted-foreground">{t("oct19Voice.thisCallerIsTalkingToThe_1qwfq3x")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button variant="outline" disabled={busy} onClick={() => onDecide({approve: false, approvalCode: call.approvalCode})}>{t("oct19Voice.endCall_ac9342")}</Button>
  </section>;
  return <section className="max-w-xl space-y-3 rounded-md border border-border p-3" aria-label={t("oct19Voice.incomingCallApproval_1u8qg2y")}>
    <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold">{call.state === "approved" ? t("oct19Voice.callApproved_15mzt30") : call.state === "denied" ? t("oct19Voice.callDenied_1jpfg54") : call.state === "expired" ? t("oct19Voice.callExpired_76omf4") : call.state === "ended" ? t("oct19Voice.callerHungUp_12y8wqr") : t("oct19Voice.incomingCallAwaitingApproval_p9hgum")}</h3>
    {call.intakeIssueId && <Link className="text-sm text-primary underline" to={`/issues/${encodeURIComponent(call.intakeIssueId)}`}>{t("oct19Voice.reviewPhoneIntake_12rtq6r")}</Link>}
    {pending ? <form className="space-y-3" onSubmit={event => {event.preventDefault(); if (code !== call.approvalCode) {setInvalid(true); return;} setInvalid(false); onDecide({approve: true, approvalCode: code, ...(issueId ? {issueId} : {})});}}>
      <p className="text-sm text-muted-foreground">{t("oct19Voice.approveOnlyTheCallYouAre_58a4bp")}</p>
      <label className="grid gap-2 text-sm font-medium">{t("oct19Voice.codeSpokenOnYourCall_1j7jpem")}<Input inputMode="numeric" autoComplete="off" maxLength={6} value={code} disabled={busy} aria-invalid={invalid} onChange={event => {setCode(event.target.value); setInvalid(false);}} /></label>
      <label className="grid min-w-0 gap-2 text-sm font-medium">{t("oct19Voice.conversationTask_1wckt7j")}<select data-voice-task-select aria-label={t("oct19Voice.conversationTask_1wckt7j")} className="w-full min-w-0 rounded-md border border-input bg-background p-2 text-sm" disabled={busy} value={issueId} onChange={event => setIssueId(event.target.value)}><option value="">{t("oct19Voice.continueYourConversationOrCreateOne_1eicqv9")}</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.label}</option>)}</select></label>
      {invalid && <p role="alert" className="text-sm text-destructive">{t("oct19Voice.thatCodeDoesNotMatchThis_egpot0")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => onDecide({approve: false, approvalCode: call.approvalCode})}>{t("oct19Voice.denyCall_qrev2h")}</Button><Button type="submit" disabled={busy}>{busy ? t("oct19Voice.confirming_1k7ph19") : t("oct19Voice.approveLiveCall_moino4")}</Button></div>
    </form> : <p className="text-sm text-muted-foreground">{call.state === "approved" ? t("oct19Voice.approvalWasSentForThisCall_6oyxj5") : t("oct19Voice.thisCallCannotAccessYourPrivate_l6x81c")}</p>}
  </section>;
}
export function SpekoIncomingCalls({companyId, endpointId, agentId}: {companyId: string; endpointId: string; agentId: string}) {
  useTranslation();
  const [decision, setDecision] = useState<VoiceInboundCall>();
  const host = useRef<HTMLDivElement>(null), restoreTaskFocus = useRef(false);
  useEffect(() => {
    if (!decision) return;
    // The pending-call API omits approved calls; this is a brief confirmation,
    // not a live status indicator after the caller hangs up.
    const timeout = setTimeout(() => setDecision(undefined), 5000);
    return () => clearTimeout(timeout);
  }, [decision]);
  useEffect(() => { setDecision(undefined); restoreTaskFocus.current = false; }, [companyId, endpointId]);
  const query = useQuery({queryKey: ["speko-incoming", companyId, endpointId], queryFn: () => voicePhoneApi.incoming(companyId, endpointId), refetchInterval: 2000, retry: false});
  const needsTaskSelection = Boolean(query.data?.some(call => ["awaiting_approval", "approving"].includes(call.state)));
  const tasks = useQuery({queryKey: ["speko-approval-tasks", companyId, agentId], queryFn: () => issuesApi.list(companyId, {assigneeAgentId: agentId}), enabled: needsTaskSelection, retry: false});
  useEffect(() => {
    if (restoreTaskFocus.current && !tasks.isFetching && !tasks.isError) {
      restoreTaskFocus.current = false;
      host.current?.querySelector<HTMLSelectElement>('select[data-voice-task-select]')?.focus();
    }
  }, [tasks.data, tasks.isFetching, tasks.isError]);
  const mutation = useMutation({mutationFn: ({id, ...input}: {id: string; approve: boolean; approvalCode: string; issueId?: string}) => voicePhoneApi.decide(companyId, endpointId, id, input), onSuccess: result => { setDecision(result); return query.refetch(); }});
  return <div ref={host} className="space-y-3">{needsTaskSelection && tasks.isError && <div role="alert" className="space-y-2 text-sm"><p>{t("oct19Voice.taskListCouldNotBeLoaded_6o6y1t")}</p><Button variant="outline" disabled={tasks.isFetching} onClick={() => { restoreTaskFocus.current = true; void tasks.refetch().then(result => { if (result.isError) restoreTaskFocus.current = false; }); }}>{t("oct19Voice.retryTasks_1fg2a8r")}</Button></div>}{query.error && <p role="alert" className="text-sm text-destructive">{t("oct19Voice.incomingCallApprovalIsUnavailable_fs033m")} {query.error.message}</p>}{!query.error && [...(query.data ?? []).filter(call => call.id !== decision?.id), ...(decision ? [decision] : [])].map(call => <SpekoIncomingCallCard key={call.id} call={call} tasks={tasks.data?.filter(task => !["done", "cancelled"].includes(task.status)).map(task => ({id: task.id, label: `${task.identifier ?? t("oct19Voice.task_x0051o")} · ${task.title}`}))} busy={mutation.isPending && mutation.variables?.id === call.id} error={mutation.variables?.id === call.id ? mutation.error?.message : undefined} onDecide={input => mutation.mutate({id: call.id, ...input})} />)}</div>;
}
