import { t, useTranslation } from "@/i18n";
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
export interface SpekoIncomingCallCardProps { call: VoiceInboundCall; tasks?: {id: string; label: string}[]; busy?: boolean; error?: string; onDecide(input: {approve: boolean; approvalCode: string; issueId?: string}): void }
export function SpekoIncomingCallCard({call, tasks = [], busy, error, onDecide}: SpekoIncomingCallCardProps) {
  const { t } = useTranslation("connections");
  const [code, setCode] = useState(""), [issueId, setIssueId] = useState(""), [invalid, setInvalid] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = ["guest_intake", "awaiting_approval", "approving"].includes(call.state);
  useEffect(() => { if (!pending) heading.current?.focus(); }, [pending]);
  if (call.state === "guest_intake") return <section className="max-w-xl space-y-3 rounded-md border border-border p-3" aria-label={t("incoming_conversation_800e302")}>
    <h3 className="text-sm font-semibold">{t("incoming_conversation_800e302")}</h3>
    {call.intakeIssueId && <Link className="text-sm text-primary underline" to={`/issues/${call.intakeIssueId}`}>{t("open_conversation_task_974d55c")}</Link>}
    <p className="text-sm text-muted-foreground">{t("this_caller_is_talking_to_the_agent_60f9ba8")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button variant="outline" disabled={busy} onClick={() => onDecide({approve: false, approvalCode: call.approvalCode})}>{t("end_call_c8de761")}</Button>
  </section>;
  return <section className="max-w-xl space-y-3 rounded-md border border-border p-3" aria-label={t("incoming_call_approval_427bb57")}>
    <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold">{call.state === "approved" ? t("call_approved_8249c16") : call.state === "denied" ? t("call_denied_56c417b") : call.state === "expired" ? t("call_expired_18436c6") : call.state === "ended" ? t("caller_hung_up_c698c73") : t("incoming_call_awaiting_approval_8057d0b")}</h3>
    {call.intakeIssueId && <Link className="text-sm text-primary underline" to={`/issues/${encodeURIComponent(call.intakeIssueId)}`}>{t("review_phone_intake_ea83c18")}</Link>}
    {pending ? <form className="space-y-3" onSubmit={event => {event.preventDefault(); if (code !== call.approvalCode) {setInvalid(true); return;} setInvalid(false); onDecide({approve: true, approvalCode: code, ...(issueId ? {issueId} : {})});}}>
      <p className="text-sm text-muted-foreground">{t("approve_only_the_call_you_are_currently_7ad4e05")}</p>
      <label className="grid gap-2 text-sm font-medium">{t("code_spoken_on_your_call_ac30470")}<Input inputMode="numeric" autoComplete="off" maxLength={6} value={code} disabled={busy} aria-invalid={invalid} onChange={event => {setCode(event.target.value); setInvalid(false);}} /></label>
      <label className="grid min-w-0 gap-2 text-sm font-medium">{t("conversation_task_3204e34")}<select aria-label={t("conversation_task_3204e34")} className="w-full min-w-0 rounded-md border border-input bg-background p-2 text-sm" disabled={busy} value={issueId} onChange={event => setIssueId(event.target.value)}><option value="">{t("continue_your_conversation_or_create_one_011262c")}</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.label}</option>)}</select></label>
      {invalid && <p role="alert" className="text-sm text-destructive">{t("that_code_does_not_match_this_live_32dcb54")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => onDecide({approve: false, approvalCode: call.approvalCode})}>{t("deny_call_3d69aed")}</Button><Button type="submit" disabled={busy}>{busy ? t("confirming_0c2708b") : t("approve_live_call_1c36a0f")}</Button></div>
    </form> : <p className="text-sm text-muted-foreground">{call.state === "approved" ? t("approval_was_sent_for_this_call_earlier_29e8306") : t("this_call_cannot_access_your_private_tasks_c9e8d2e")}</p>}
  </section>;
}
export function SpekoIncomingCalls({companyId, endpointId, agentId}: {companyId: string; endpointId: string; agentId: string}) {
  const { t } = useTranslation("connections");
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
      host.current?.querySelector<HTMLSelectElement>('select')?.focus();
    }
  }, [tasks.data, tasks.isFetching, (tasksView.kind === "error")]);
  const mutation = useMutation({mutationFn: ({id, ...input}: {id: string; approve: boolean; approvalCode: string; issueId?: string}) => voicePhoneApi.decide(companyId, endpointId, id, input), onSuccess: result => { setDecision(result); return query.refetch(); }});
  return <div ref={host} className="space-y-3">{needsTaskSelection && (tasksView.kind === "error") && <div role="alert" className="space-y-2 text-sm"><p>{t("task_list_could_not_be_loaded_retry_abc2427")}</p><Button variant="outline" disabled={tasks.isFetching} onClick={() => { restoreTaskFocus.current = true; void tasks.refetch().then(result => { if (result.status === "error") restoreTaskFocus.current = false; }); }}>{t("retry_tasks_70a15c3")}</Button></div>}{queryView.kind === "error" && <p role="alert" className="text-sm text-destructive">{t("incoming_call_approval_is_unavailable_40c2cd9", { body: describeError(query.error).body })}</p>}{queryView.kind !== "error" && [...(query.data ?? []).filter(call => call.id !== decision?.id), ...(decision ? [decision] : [])].map(call => <SpekoIncomingCallCard key={call.id} call={call} tasks={tasks.data?.filter(task => !["done", "cancelled"].includes(task.status)).map(task => ({id: task.id, label: `${task.identifier ?? t("final-components-a:task_4bc74b21")} · ${task.title}`}))} busy={mutation.isPending && mutation.variables?.id === call.id} error={mutation.variables?.id === call.id ? mutation.error?.message : undefined} onDecide={input => mutation.mutate({id: call.id, ...input})} />)}</div>;
}
