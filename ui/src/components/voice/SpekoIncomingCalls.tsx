import { useQueryView } from "@/components/QueryView";
import { describeError } from "@/api/errors";
import { Link } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { VoiceInboundCall } from "@paperclipai/shared";
import { voicePhoneApi } from "@/api/voicePhone";
import { issuesApi } from "@/api/issues";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
export interface SpekoIncomingCallCardProps { call: VoiceInboundCall; tasks?: {id: string; label: string}[]; busy?: boolean; error?: string; onDecide(input: {approve: boolean; approvalCode: string; issueId?: string}): void }
export function SpekoIncomingCallCard({call, tasks = [], busy, error, onDecide}: SpekoIncomingCallCardProps) {
  const [code, setCode] = useState(""), [issueId, setIssueId] = useState(""), [invalid, setInvalid] = useState(false);
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = ["guest_intake", "awaiting_approval", "approving"].includes(call.state);
  useEffect(() => { if (!pending) heading.current?.focus(); }, [pending]);
  if (call.state === "guest_intake") return <section className="max-w-xl space-y-3 rounded-md border border-border p-3" aria-label={t("agents.SpekoIncomingCallCard.conversationLabel")}>
    <h3 className="text-sm font-semibold">{t("agents.SpekoIncomingCallCard.conversationLabel")}</h3>
    {call.intakeIssueId && <Link className="text-sm text-primary underline" to={`/issues/${call.intakeIssueId}`}>{t("agents.SpekoIncomingCallCard.openTask")}</Link>}
    <p className="text-sm text-muted-foreground">{t("agents.SpekoIncomingCallCard.intakeNotice")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button variant="outline" disabled={busy} onClick={() => onDecide({approve: false, approvalCode: call.approvalCode})}>{t("agents.SpekoIncomingCallCard.endCall")}</Button>
  </section>;
  return <section className="max-w-xl space-y-3 rounded-md border border-border p-3" aria-label={t("agents.SpekoIncomingCallCard.approvalLabel")}>
    <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold">{call.state === "approved" ? t("agents.SpekoIncomingCallCard.approved") : call.state === "denied" ? t("agents.SpekoIncomingCallCard.denied") : call.state === "expired" ? t("agents.SpekoIncomingCallCard.expired") : call.state === "ended" ? t("agents.SpekoIncomingCallCard.hungUp") : t("agents.SpekoIncomingCallCard.awaiting")}</h3>
    {call.intakeIssueId && <Link className="text-sm text-primary underline" to={`/issues/${encodeURIComponent(call.intakeIssueId)}`}>{t("agents.SpekoIncomingCallCard.reviewIntake")}</Link>}
    {pending ? <form className="space-y-3" onSubmit={event => {event.preventDefault(); if (code !== call.approvalCode) {setInvalid(true); return;} setInvalid(false); onDecide({approve: true, approvalCode: code, ...(issueId ? {issueId} : {})});}}>
      <p className="text-sm text-muted-foreground">{t("agents.SpekoIncomingCallCard.approveNotice")}</p>
      <label className="grid gap-2 text-sm font-medium">{t("agents.SpekoIncomingCallCard.codeLabel")}<Input inputMode="numeric" autoComplete="off" maxLength={6} value={code} disabled={busy} aria-invalid={invalid} onChange={event => {setCode(event.target.value); setInvalid(false);}} /></label>
      <label className="grid min-w-0 gap-2 text-sm font-medium">{t("agents.SpekoIncomingCallCard.taskLabel")}<select data-conversation-task aria-label={t("agents.SpekoIncomingCallCard.taskLabel")} className="w-full min-w-0 rounded-md border border-input bg-background p-2 text-sm" disabled={busy} value={issueId} onChange={event => setIssueId(event.target.value)}><option value="">{t("agents.SpekoIncomingCallCard.taskPlaceholder")}</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.label}</option>)}</select></label>
      {invalid && <p role="alert" className="text-sm text-destructive">{t("agents.SpekoIncomingCallCard.codeMismatch")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => onDecide({approve: false, approvalCode: call.approvalCode})}>{t("agents.SpekoIncomingCallCard.denyCall")}</Button><Button type="submit" disabled={busy}>{busy ? t("agents.SpekoIncomingCallCard.confirming") : t("agents.SpekoIncomingCallCard.approveLive")}</Button></div>
    </form> : <p className="text-sm text-muted-foreground">{call.state === "approved" ? t("agents.SpekoIncomingCallCard.approvalSent") : t("agents.SpekoIncomingCallCard.noAccess")}</p>}
  </section>;
}
export function SpekoIncomingCalls({companyId, endpointId, agentId}: {companyId: string; endpointId: string; agentId: string}) {
  const { t } = useTranslation();
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
  const query = useQuery({queryKey: ["speko-incoming", companyId, endpointId], queryFn: () => voicePhoneApi.incoming(companyId, endpointId), refetchInterval: 2000});
  const queryView = useQueryView(query);
  const needsTaskSelection = Boolean(query.data?.some(call => ["awaiting_approval", "approving"].includes(call.state)));
  const tasks = useQuery({queryKey: ["speko-approval-tasks", companyId, agentId], queryFn: () => issuesApi.list(companyId, {assigneeAgentId: agentId}), enabled: needsTaskSelection});
  const tasksView = useQueryView(tasks);
  useEffect(() => {
    if (restoreTaskFocus.current && !tasks.isFetching && !(tasksView.kind === "error")) {
      restoreTaskFocus.current = false;
      host.current?.querySelector<HTMLSelectElement>('select[data-conversation-task]')?.focus();
    }
  }, [tasks.data, tasks.isFetching, (tasksView.kind === "error")]);
  const mutation = useMutation({mutationFn: ({id, ...input}: {id: string; approve: boolean; approvalCode: string; issueId?: string}) => voicePhoneApi.decide(companyId, endpointId, id, input), onSuccess: result => { setDecision(result); return query.refetch(); }});
  return <div ref={host} className="space-y-3">{needsTaskSelection && (tasksView.kind === "error") && <div role="alert" className="space-y-2 text-sm"><p>{t("agents.SpekoIncomingCalls.tasksError")}</p><Button variant="outline" disabled={tasks.isFetching} onClick={() => { restoreTaskFocus.current = true; void tasks.refetch().then(result => { if (result.status === "error") restoreTaskFocus.current = false; }); }}>{t("agents.SpekoIncomingCalls.retryTasks")}</Button></div>}{queryView.kind === "error" && <p role="alert" className="text-sm text-destructive">{t("agents.SpekoIncomingCalls.unavailable", { error: describeError(query.error).body })}</p>}{queryView.kind !== "error" && [...(query.data ?? []).filter(call => call.id !== decision?.id), ...(decision ? [decision] : [])].map(call => <SpekoIncomingCallCard key={call.id} call={call} tasks={tasks.data?.filter(task => !["done", "cancelled"].includes(task.status)).map(task => ({id: task.id, label: `${task.identifier ?? t("agents.SpekoIncomingCalls.taskFallback")} · ${task.title}`}))} busy={mutation.isPending && mutation.variables?.id === call.id} error={mutation.variables?.id === call.id ? mutation.error?.message : undefined} onDecide={input => mutation.mutate({id: call.id, ...input})} />)}</div>;
}
