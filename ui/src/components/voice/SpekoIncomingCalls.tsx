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
  const [code, setCode] = useState(""), [issueId, setIssueId] = useState(""), [invalid, setInvalid] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = ["guest_intake", "awaiting_approval", "approving"].includes(call.state);
  useEffect(() => { if (!pending) heading.current?.focus(); }, [pending]);
  if (call.state === "guest_intake") return <section className="max-w-xl space-y-3 rounded-md border border-border p-3" aria-label="Incoming conversation">
    <h3 className="text-sm font-semibold">Incoming conversation</h3>
    {call.intakeIssueId && <Link className="text-sm text-primary underline" to={`/issues/${call.intakeIssueId}`}>Open conversation task</Link>}
    <p className="text-sm text-muted-foreground">This caller is talking to the agent in a new low-trust task.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button variant="outline" disabled={busy} onClick={() => onDecide({approve: false, approvalCode: call.approvalCode})}>End call</Button>
  </section>;
  return <section className="max-w-xl space-y-3 rounded-md border border-border p-3" aria-label="Incoming call approval">
    <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold">{call.state === "approved" ? "Call approved" : call.state === "denied" ? "Call denied" : call.state === "expired" ? "Call expired" : call.state === "ended" ? "Caller hung up" : "Incoming call awaiting approval"}</h3>
    {call.intakeIssueId && <Link className="text-sm text-primary underline" to={`/issues/${encodeURIComponent(call.intakeIssueId)}`}>Review phone intake</Link>}
    {pending ? <form className="space-y-3" onSubmit={event => {event.preventDefault(); if (code !== call.approvalCode) {setInvalid(true); return;} setInvalid(false); onDecide({approve: true, approvalCode: code, ...(issueId ? {issueId} : {})});}}>
      <p className="text-sm text-muted-foreground">Approve only the call you are currently on. Enter the six-digit code spoken on the phone. Approval gives this call your access to the selected task.</p>
      <label className="grid gap-2 text-sm font-medium">Code spoken on your call<Input inputMode="numeric" autoComplete="off" maxLength={6} value={code} disabled={busy} aria-invalid={invalid} onChange={event => {setCode(event.target.value); setInvalid(false);}} /></label>
      <label className="grid min-w-0 gap-2 text-sm font-medium">Conversation task<select aria-label="Conversation task" className="w-full min-w-0 rounded-md border border-input bg-background p-2 text-sm" disabled={busy} value={issueId} onChange={event => setIssueId(event.target.value)}><option value="">Continue your conversation, or create one</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.label}</option>)}</select></label>
      {invalid && <p role="alert" className="text-sm text-destructive">That code does not match this live call. Ask the phone agent to repeat it.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => onDecide({approve: false, approvalCode: call.approvalCode})}>Deny call</Button><Button type="submit" disabled={busy}>{busy ? "Confirming…" : "Approve live call"}</Button></div>
    </form> : <p className="text-sm text-muted-foreground">{call.state === "approved" ? "Approval was sent for this call. Earlier instructions were discarded. Follow the call in Activity." : "This call cannot access your private tasks."}</p>}
  </section>;
}
export function SpekoIncomingCalls({companyId, endpointId, agentId}: {companyId: string; endpointId: string; agentId: string}) {
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
      host.current?.querySelector<HTMLSelectElement>('select[aria-label="Conversation task"]')?.focus();
    }
  }, [tasks.data, tasks.isFetching, tasks.isError]);
  const mutation = useMutation({mutationFn: ({id, ...input}: {id: string; approve: boolean; approvalCode: string; issueId?: string}) => voicePhoneApi.decide(companyId, endpointId, id, input), onSuccess: result => { setDecision(result); return query.refetch(); }});
  return <div ref={host} className="space-y-3">{needsTaskSelection && tasks.isError && <div role="alert" className="space-y-2 text-sm"><p>Task list could not be loaded. Retry to choose an existing task.</p><Button variant="outline" disabled={tasks.isFetching} onClick={() => { restoreTaskFocus.current = true; void tasks.refetch().then(result => { if (result.isError) restoreTaskFocus.current = false; }); }}>Retry tasks</Button></div>}{query.error && <p role="alert" className="text-sm text-destructive">Incoming call approval is unavailable. {query.error.message}</p>}{!query.error && [...(query.data ?? []).filter(call => call.id !== decision?.id), ...(decision ? [decision] : [])].map(call => <SpekoIncomingCallCard key={call.id} call={call} tasks={tasks.data?.filter(task => !["done", "cancelled"].includes(task.status)).map(task => ({id: task.id, label: `${task.identifier ?? "Task"} · ${task.title}`}))} busy={mutation.isPending && mutation.variables?.id === call.id} error={mutation.variables?.id === call.id ? mutation.error?.message : undefined} onDecide={input => mutation.mutate({id: call.id, ...input})} />)}</div>;
}
