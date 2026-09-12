import {
  AssigneePicker,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  Command, CompanyState, Decision, EvidenceRef, Improvement, MemoryStatus, PolicyBundle,
} from "../domain.js";

type Run = (command: Command) => Promise<boolean>;
interface ViewProps { state: CompanyState; run: Run; busy: boolean }
type Tab = "Overview" | "Instructions" | "Memory" | "Decisions" | "Improvement";
const tabs: Tab[] = ["Overview", "Instructions", "Memory", "Decisions", "Improvement"];
const blankBundle: PolicyBundle = { instructions: [], constraints: [], skills: [], hooks: [] };
const stack: CSSProperties = { display: "grid", gap: "calc(var(--spacing) * 4)", minWidth: 0 };
const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "calc(var(--spacing) * 3)", alignItems: "center" };
const muted: CSSProperties = { color: "var(--muted-foreground)" };
const control: CSSProperties = {
  width: "100%", boxSizing: "border-box", color: "var(--foreground)", background: "var(--background)",
  border: "thin solid var(--input)", borderRadius: "var(--radius-md)", padding: "calc(var(--spacing) * 2)",
  font: "inherit",
};
const button: CSSProperties = {
  font: "inherit", color: "var(--primary-foreground)", background: "var(--primary)",
  border: "thin solid var(--primary)", borderRadius: "var(--radius-md)", padding: "calc(var(--spacing) * 2) calc(var(--spacing) * 3)",
  cursor: "pointer",
};
const secondary: CSSProperties = { ...button, background: "var(--background)", color: "var(--foreground)", borderColor: "var(--border)" };
const mono: CSSProperties = { fontFamily: "var(--font-mono)", overflowWrap: "anywhere" };

function text(data: FormData, name: string): string { return String(data.get(name) ?? "").trim(); }
function selectedPerson(data: FormData, name: string, label: string): string {
  const value = text(data, name);
  if (!value) throw new Error(`Choose ${label} before saving.`);
  return value;
}
function lines(data: FormData, name: string): string[] { return text(data, name).split("\n").map((line) => line.trim()).filter(Boolean); }
function number(data: FormData, name: string): number {
  const raw = text(data, name);
  if (!raw || !Number.isFinite(Number(raw))) throw new Error(`Enter a valid number for ${name.replaceAll("-", " ")}.`);
  return Number(raw);
}
function date(data: FormData, name: string): string {
  const parsed = new Date(text(data, name));
  if (Number.isNaN(parsed.getTime())) throw new Error("Choose a valid deadline.");
  return parsed.toISOString();
}
function evidence(data: FormData, name = "evidence"): EvidenceRef[] {
  return lines(data, name).map((line) => {
    const split = line.lastIndexOf("|");
    const ref = line.slice(0, split).trim();
    const digest = line.slice(split + 1).trim().toLowerCase();
    if (split < 1 || !ref || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("Each evidence line needs a source reference, a | separator and its 64-character SHA-256 digest.");
    }
    return { ref, digest };
  });
}
function readBundle(data: FormData): PolicyBundle {
  const skills: PolicyBundle["skills"] = [];
  const hooks: PolicyBundle["hooks"] = [];
  for (const key of data.keys()) {
    if (key.startsWith("skill-name-")) {
      const name = text(data, key); const content = text(data, key.replace("name", "content"));
      if (name || content) skills.push({ name, content });
    }
    if (key.startsWith("hook-event-")) {
      const event = text(data, key); const instruction = text(data, key.replace("event", "instruction"));
      if (event || instruction) hooks.push({ event, instruction });
    }
  }
  return { instructions: lines(data, "instructions"), constraints: lines(data, "constraints"), skills, hooks };
}
function id(): string { return crypto.randomUUID(); }
function timestamp(value: string): string { return new Date(value).toLocaleString(); }

function Field({ label, name, value, help, multiline, required = true, type = "text", min, max, step }: {
  label: string; name: string; value?: string | number; help?: string; multiline?: boolean;
  required?: boolean; type?: string; min?: number; max?: number; step?: string;
}) {
  return <label style={stack}>
    <span>{label}</span>
    {multiline
      ? <textarea style={{ ...control, resize: "vertical" }} name={name} defaultValue={value} rows={4} required={required} />
      : <input style={control} name={name} defaultValue={value} type={type} min={min} max={max} step={step} required={required} />}
    {help && <small style={muted}>{help}</small>}
  </label>;
}
function Select({ label, name, options, value }: { label: string; name: string; options: { value: string; label: string }[]; value?: string }) {
  return <label style={stack}><span>{label}</span><select style={control} name={name} defaultValue={value} required>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>;
}
function OwnerField({ label, name, includeUsers = true }: { label: string; name: string; includeUsers?: boolean }) {
  const [selection, setSelection] = useState("");
  const [ownerId, setOwnerId] = useState("");
  return <div role="group" aria-label={label} style={stack}><span>{label}</span>
    <AssigneePicker value={selection} includeUsers={includeUsers} placeholder={`Choose ${label.toLowerCase()}`} onChange={(value, owner) => {
      setSelection(value); setOwnerId(owner.assigneeAgentId ?? owner.assigneeUserId ?? "");
    }} />
    <input type="hidden" name={name} value={ownerId} />
  </div>;
}
function Section({ title, children, description }: { title: string; children: ReactNode; description?: string }) {
  return <section style={stack}><h2 className="text-lg font-semibold">{title}</h2>{description && <p style={muted}>{description}</p>}{children}</section>;
}
function Form({ label, busy, run, command, children, reset = true }: {
  label: string; busy: boolean; run: Run; command: (data: FormData) => Command; children: ReactNode; reset?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  return <form onSubmit={async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setError(null);
    try {
      const accepted = await run(command(new FormData(form)));
      if (accepted && reset) form.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Check the form and try again."); }
  }}>
    <fieldset disabled={busy} style={{ ...stack, border: "none", padding: 0, margin: 0, minWidth: 0 }}>
      {children}
      {error && <p role="alert" style={{ color: "var(--destructive)" }}>{error}</p>}
      <div><button style={{ ...button, cursor: busy ? "wait" : "pointer" }} type="submit">{busy ? "Saving…" : label}</button></div>
    </fieldset>
  </form>;
}
function EvidenceFields({ name = "evidence", required = true }: { name?: string; required?: boolean }) {
  return <Field name={name} label="Evidence references" multiline required={required}
    help="One reference | SHA-256 digest per line. References record provenance; the plugin does not fetch them or establish that a claim is true. For a skipped evaluation, reference the record explaining the skip." />;
}
function EvidenceList({ refs }: { refs: EvidenceRef[] }) {
  return refs.length ? <ul style={stack}>{refs.map((item, index) => <li key={`${item.ref}-${index}`}>
    <span style={mono}>{item.ref}</span><br /><small style={{ ...mono, ...muted }}>SHA-256 {item.digest}</small>
  </li>)}</ul> : <p style={muted}>No evidence references recorded.</p>;
}
function BundleFields({ bundle = blankBundle }: { bundle?: PolicyBundle }) {
  const [skills, setSkills] = useState(bundle.skills.map((skill) => ({ ...skill, key: id() })));
  const [hooks, setHooks] = useState(bundle.hooks.map((hook) => ({ ...hook, key: id() })));
  return <>
    <Field name="instructions" label="Shared instructions" multiline value={bundle.instructions.join("\n")} help="One instruction per line." />
    <Field name="constraints" label="Constraints" multiline required={false} value={bundle.constraints.join("\n")} help="One constraint per line. These are recorded guidance, not a replacement for runtime permissions." />
    <details><summary>Skills and hook guidance</summary><div style={stack}>
      {skills.map((skill, index) => <div key={skill.key} style={stack}>
        <Field name={`skill-name-${index}`} label={`Skill ${index + 1} name`} value={skill.name} />
        <Field name={`skill-content-${index}`} label={`Skill ${index + 1} instructions`} multiline value={skill.content} />
        <button type="button" style={secondary} onClick={() => setSkills((rows) => rows.filter((row) => row.key !== skill.key))}>Remove skill {index + 1}</button>
      </div>)}
      <button type="button" style={secondary} onClick={() => setSkills((rows) => [...rows, { name: "", content: "", key: id() }])}>Add skill</button>
      <p style={muted}>Hook entries describe guidance for a named event. This plugin does not execute hooks or install them in provider tools.</p>
      {hooks.map((hook, index) => <div key={hook.key} style={stack}>
        <Field name={`hook-event-${index}`} label={`Hook ${index + 1} event`} value={hook.event} />
        <Field name={`hook-instruction-${index}`} label={`Hook ${index + 1} guidance`} multiline value={hook.instruction} />
        <button type="button" style={secondary} onClick={() => setHooks((rows) => rows.filter((row) => row.key !== hook.key))}>Remove hook {index + 1}</button>
      </div>)}
      <button type="button" style={secondary} onClick={() => setHooks((rows) => [...rows, { event: "", instruction: "", key: id() }])}>Add hook guidance</button>
    </div></details>
  </>;
}
function BundleView({ bundle }: { bundle: PolicyBundle }) {
  return <div style={stack}>
    <strong>Instructions</strong><ul>{bundle.instructions.map((line, index) => <li key={index}>{line}</li>)}</ul>
    {bundle.constraints.length > 0 && <><strong>Constraints</strong><ul>{bundle.constraints.map((line, index) => <li key={index}>{line}</li>)}</ul></>}
    {bundle.skills.map((skill, index) => <details key={index}><summary>{skill.name}</summary><p style={{ whiteSpace: "pre-wrap" }}>{skill.content}</p></details>)}
    {bundle.hooks.map((hook, index) => <details key={index}><summary>Hook guidance: {hook.event}</summary><p style={{ whiteSpace: "pre-wrap" }}>{hook.instruction}</p><small style={muted}>Declarative guidance; not executed by this plugin.</small></details>)}
  </div>;
}

function Overview({ state, go }: { state: CompanyState; go: (tab: Tab) => void }) {
  const open = state.decisions.filter((decision) => !decision.resolution);
  const active = state.policies.find((policy) => policy.id === state.activePolicyId);
  return <>
    <Section title="What needs attention">
      {!active && <p>Publish the first shared instruction version to establish the company baseline.</p>}
      <div style={row}>
        <button style={secondary} onClick={() => go("Decisions")}>{open.length} open decisions</button>
        <button style={secondary} onClick={() => go("Memory")}>{state.memories.filter((memory) => memory.status === "stale" || memory.status === "contested").length} memories to review</button>
        <button style={secondary} onClick={() => go("Improvement")}>{state.improvements.filter((item) => !item.promotedAt).length} improvement proposals</button>
      </div>
      <p style={muted}>A decision can conclude with no change, deferment or escalation. Available subscription capacity is not a reason to alter a product.</p>
    </Section>
    <Section title="Current shared instructions">
      {active ? <><p>Active version <span style={mono}>{active.id}</span></p><BundleView bundle={active.bundle} /></>
        : <button style={button} onClick={() => go("Instructions")}>Set up shared instructions</button>}
    </Section>
    <Section title="Recent activity" description="Recorded actions in this company. Actor identity comes from Paperclip.">
      {state.events.length === 0 ? <p style={muted}>Activity appears after the first saved action.</p>
        : <ol style={stack}>{state.events.slice(-12).reverse().map((event, index) => <li key={`${event.at}-${index}`}>
          <div>{event.type.replaceAll(".", " · ")} · {event.actor.kind} <span style={mono}>{event.actor.id}</span></div>
          {event.reason && <p>{event.reason}</p>}<small style={muted}>{timestamp(event.at)}</small>
        </li>)}</ol>}
    </Section>
  </>;
}
function Instructions({ state, run, busy }: ViewProps) {
  return <>
    {state.policies.length === 0 && <Section title="Publish the initial instructions" description="This establishes and activates the first approved version. Later changes go through Improvement.">
      <Form label="Publish and activate initial version" busy={busy} run={run} command={(data) => ({ type: "policy.publish", id: id(), bundle: readBundle(data), reason: text(data, "reason") })}>
        <BundleFields /><Field name="reason" label="Why these instructions" multiline />
      </Form>
    </Section>}
    <Section title="Instruction versions" description="Approved versions can be activated again to roll back a change. History is retained.">
      {state.policies.map((policy) => <details key={policy.id} open={policy.id === state.activePolicyId}>
        <summary><span style={mono}>{policy.id}</span> · {policy.id === state.activePolicyId ? "Active" : state.approvedPolicyIds.includes(policy.id) ? "Approved" : "Candidate"}</summary>
        <div style={stack}><small style={{ ...mono, ...muted }}>SHA-256 {policy.digest}</small><BundleView bundle={policy.bundle} />
          {policy.id !== state.activePolicyId && state.approvedPolicyIds.includes(policy.id) && <Form label="Activate this approved version" busy={busy} run={run} command={(data) => ({ type: "policy.activate", policyId: policy.id, reason: text(data, "reason") })}>
            <Field name="reason" label="Reason for activation or rollback" />
          </Form>}
        </div>
      </details>)}
      {state.policies.length === 0 && <p style={muted}>No instruction versions yet.</p>}
    </Section>
  </>;
}
function CurrentTaskHead({ companyId, taskId }: { companyId: string; taskId: string }) {
  const { data, error, loading } = usePluginData<{ taskRevision: string; receiverId: string | null }>("task-head", { companyId, taskId });
  if (loading) return <p role="status">Reading the current task…</p>;
  if (error) return <p role="alert">Could not read this task: {error.message}</p>;
  return data ? <>
    <input type="hidden" name="task" value={taskId} />
    <input type="hidden" name="revision" value={data.taskRevision} />
    <input type="hidden" name="receiver" value={data.receiverId ?? ""} />
    <p>{data.receiverId ? "Current task and assigned receiver loaded. Changes before saving will require a fresh snapshot." : "Assign this task to an agent before preparing a handoff."}</p>
  </> : null;
}
function TaskHeadFields({ companyId }: { companyId: string }) {
  const [draft, setDraft] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  return <div style={stack}>
    <label style={stack}>Task ID<input style={control} value={draft} onChange={(event) => { setDraft(event.target.value); setTaskId(null); }} placeholder="Paste the Paperclip task ID" /></label>
    <button type="button" style={secondary} disabled={!draft.trim()} onClick={() => { setTaskId(draft.trim()); setReadAttempt((attempt) => attempt + 1); }}>Read current task</button>
    {taskId && <CurrentTaskHead key={`${taskId}:${readAttempt}`} companyId={companyId} taskId={taskId} />}
  </div>;
}
function Memory({ state, run, busy, companyId }: ViewProps & { companyId: string }) {
  return <>
    <Section title="Add sourced memory" description="Record a useful fact or decision with its source. Keep credentials out of memory and evidence fields.">
      <Form label="Save memory" busy={busy} run={run} command={(data) => ({ type: "memory.put", id: id(), title: text(data, "title"), content: text(data, "content"), provenanceRefs: evidence(data), expectedRevision: null })}>
        <Field name="title" label="Memory title" /><Field name="content" label="What should be remembered" multiline /><EvidenceFields />
      </Form>
    </Section>
    <Section title="Company memory">
      {state.memories.length === 0 && <p style={muted}>No memories recorded. Add a sourced fact above.</p>}
      {state.memories.map((memory) => <details key={memory.id}><summary>{memory.title} · {memory.status}</summary><div style={stack}>
        <p style={{ whiteSpace: "pre-wrap" }}>{memory.content}</p><EvidenceList refs={memory.provenanceRefs} />
        <Form label="Update memory status" busy={busy} run={run} command={(data) => ({ type: "memory.status", memoryId: memory.id, status: text(data, "status") as MemoryStatus, reason: text(data, "reason"), expectedRevision: memory.revision })}>
          <Select name="status" label="Memory status" value={memory.status} options={["current", "stale", "contested", "retired"].map((value) => ({ value, label: value }))} />
          <Field name="reason" label="Reason for status change" />
        </Form>
      </div></details>)}
    </Section>
    <Section title="Prepare a handoff" description="Create an immutable snapshot of the active instructions and selected current memories. The receiving worker must acknowledge the matching digest and task revision through its authenticated action.">
      {!state.activePolicyId ? <p style={muted}>Activate shared instructions before preparing a handoff.</p> : <Form label="Create context snapshot" busy={busy} run={run} command={(data) => {
        const receiverId = text(data, "receiver");
        if (!receiverId) throw new Error("Read current task first. It must have an assigned agent before creating a context snapshot.");
        return { type: "context.snapshot", id: id(), receiverId, taskId: text(data, "task"), taskRevision: text(data, "revision"), memoryIds: data.getAll("memory").map(String), omissions: [] };
      }}>
        <TaskHeadFields companyId={companyId} />
        <fieldset style={stack}><legend>Memories to include</legend>
          {state.memories.filter((memory) => memory.status === "current").map((memory) => <label key={memory.id} style={row}><input type="checkbox" name="memory" value={memory.id} />{memory.title}</label>)}
          {!state.memories.some((memory) => memory.status === "current") && <p style={muted}>No current memories available. The snapshot will contain the active instructions.</p>}
        </fieldset>
      </Form>}
      {state.snapshots.slice().reverse().map((snapshot) => <details key={snapshot.id}><summary>{snapshot.taskId} · {snapshot.receipt ? "Receipt recorded" : "Awaiting receipt"}</summary>
        <div style={stack}><p>Receiver <span style={mono}>{snapshot.receiverId}</span> · task revision <span style={mono}>{snapshot.taskRevision}</span></p>
          <p style={mono}>Snapshot {snapshot.id}<br />SHA-256 {snapshot.digest}</p>
          <p>{snapshot.memories.length} memories included; {snapshot.omissions.length} omissions recorded.</p>
          {snapshot.omissions.length > 0 && <ul>{snapshot.omissions.map((omission, index) => <li key={index}>{omission.ref}: {omission.reason}</li>)}</ul>}
          <details><summary>Inspect the recorded snapshot</summary><pre style={{ ...mono, whiteSpace: "pre-wrap" }}>{JSON.stringify(snapshot, null, 2)}</pre></details>
        </div>
      </details>)}
    </Section>
  </>;
}

function DecisionActions({ decision, run, busy }: { decision: Decision; run: Run; busy: boolean }) {
  return <div style={stack}>
    <p>{decision.requirement}</p>
    <p style={muted}>Owner: {decision.ownerId} · {decision.riskClass} risk · {decision.reversibility} · {decision.consultations.length}/{decision.maxRounds} consultation rounds · deadline {timestamp(decision.deadline)}</p>
    {decision.requiredEvidenceRefs.length > 0 && <p>Required references: {decision.requiredEvidenceRefs.join(", ")}</p>}
    <EvidenceList refs={decision.evidenceRefs} />
    {decision.consultations.map((consultation, index) => <div key={index}><strong>Consultation {index + 1}</strong><p>{consultation.summary}</p><EvidenceList refs={consultation.evidenceRefs} /></div>)}
    {!decision.resolution || decision.resolution.outcome === "escalate" ? <>
      {decision.resolution && <p><strong>Escalated</strong> — {decision.resolution.reason}. The board can record the final outcome below.</p>}
      {!decision.resolution && <details><summary>Add consultation</summary><Form label="Record consultation" busy={busy} run={run} command={(data) => ({ type: "decision.consult", decisionId: decision.id, summary: text(data, "summary"), evidenceRefs: evidence(data) })}>
        <Field name="summary" label="Finding or objection" multiline /><EvidenceFields required={false} />
      </Form></details>}
      <details><summary>Resolve decision</summary><Form label="Record decision outcome" busy={busy} run={run} command={(data) => ({ type: "decision.resolve", decisionId: decision.id, outcome: text(data, "outcome") as NonNullable<Decision["resolution"]>["outcome"], reason: text(data, "reason"), evidenceRefs: evidence(data) })}>
        <Select name="outcome" label="Outcome" options={[{ value: "proceed", label: "Proceed" }, { value: "no_change", label: "No change" }, { value: "defer", label: "Defer" }, { value: "escalate", label: "Escalate" }]} />
        <Field name="reason" label="Decision and reasoning" multiline /><EvidenceFields required={false} />
        <p style={muted}>Recording “Proceed” does not execute or publish the proposed work.</p>
      </Form></details>
    </> : <>
      <p><strong>{decision.resolution.outcome.replaceAll("_", " ")}</strong> — {decision.resolution.reason}</p>
      <details><summary>Reopen with a changed requirement or evidence</summary><Form label="Reopen decision" busy={busy} run={run} command={(data) => ({ type: "decision.reopen", decisionId: decision.id, requirement: text(data, "requirement"), reason: text(data, "reason"), deadline: date(data, "deadline"), evidenceRefs: evidence(data) })}>
        <Field name="requirement" label="Current requirement" multiline value={decision.requirement} /><Field name="reason" label="What changed" multiline />
        <Field name="deadline" label="New decision deadline" type="datetime-local" /><EvidenceFields required={false} />
      </Form></details>
    </>}
    {decision.reopenHistory.length > 0 && <details><summary>Reopening history ({decision.reopenHistory.length})</summary><ul>{decision.reopenHistory.map((entry, index) => <li key={index}>{timestamp(entry.at)} — {entry.reason}</li>)}</ul></details>}
  </div>;
}
function Decisions({ state, run, busy }: ViewProps) {
  return <>
    <Section title="Open a bounded decision" description="State the requirement, evidence and decision window. Consultation has a fixed limit; no change is a valid outcome.">
      <Form label="Create decision" busy={busy} run={run} command={(data) => ({ type: "decision.create", id: id(), title: text(data, "title"), ownerId: selectedPerson(data, "owner", "an accountable owner"), requirement: text(data, "requirement"), riskClass: text(data, "risk") as Decision["riskClass"], reversibility: text(data, "reversibility") as Decision["reversibility"], impacts: data.getAll("impact") as Decision["impacts"], requiredEvidenceRefs: lines(data, "required-evidence"), evidenceRefs: evidence(data), maxRounds: number(data, "rounds"), deadline: date(data, "deadline") })}>
        <Field name="title" label="Decision title" /><OwnerField name="owner" label="Accountable owner" /><Field name="requirement" label="Requirement and expected benefit" multiline />
        <Select name="risk" label="Risk" options={["low", "medium", "high"].map((value) => ({ value, label: value }))} />
        <Select name="reversibility" label="Reversibility" options={[{ value: "reversible", label: "Reversible" }, { value: "irreversible", label: "Irreversible" }]} />
        <fieldset style={stack}><legend>Protected impacts</legend>{[
          ["external_publication", "External publication"], ["spend", "Spending"], ["account_change", "Account or authentication change"],
        ].map(([value, label]) => <label key={value} style={row}><input type="checkbox" name="impact" value={value} />{label}</label>)}</fieldset>
        <Field name="rounds" label="Maximum consultation rounds" type="number" value={2} min={1} max={3} step="1" />
        <Field name="deadline" label="Decision deadline" type="datetime-local" />
        <Field name="required-evidence" label="References required before proceeding" multiline help="One exact reference per line. These references must be present before a proceed outcome." />
        <EvidenceFields required={false} />
      </Form>
    </Section>
    <Section title="Decision register">
      {state.decisions.length === 0 && <p style={muted}>No decisions recorded.</p>}
      {state.decisions.slice().reverse().map((decision) => <details key={decision.id}><summary>{decision.title} · {decision.resolution ? decision.resolution.outcome.replaceAll("_", " ") : "Open"}</summary><DecisionActions decision={decision} run={run} busy={busy} /></details>)}
    </Section>
  </>;
}

function EvaluationForm({ improvement, run, busy }: { improvement: Improvement; run: Run; busy: boolean }) {
  const checkNames = [...improvement.evaluationSpec.checks, ...improvement.evaluationSpec.nonRegressionChecks];
  return <Form label="Record evaluation result" busy={busy} run={run} command={(data) => ({
    type: "improvement.evaluate", improvementId: improvement.id, baselinePolicyId: improvement.baselinePolicyId,
    specHash: improvement.specHash, evaluatorId: text(data, "evaluator"), runRef: text(data, "run"),
    checks: checkNames.map((name, index) => ({ name, status: text(data, `check-${index}`) as "passed" | "failed" | "skipped", evidenceRefs: evidence(data, `check-evidence-${index}`) })),
    metrics: improvement.evaluationSpec.metrics.map((metric, index) => ({ name: metric.name, status: text(data, `metric-${index}`) as "passed" | "failed" | "skipped", evidenceRefs: evidence(data, `metric-evidence-${index}`), baseline: text(data, `baseline-${index}`) ? number(data, `baseline-${index}`) : null, candidate: text(data, `candidate-${index}`) ? number(data, `candidate-${index}`) : null })),
  })}>
    <p style={muted}>Record results produced elsewhere. This plugin checks the submitted results against the frozen specification; it does not run the evaluation or verify the referenced artefacts.</p>
    <Field name="evaluator" label="Evaluator identity" /><Field name="run" label="Evaluation run reference" />
    {checkNames.map((name, index) => <div key={`${name}-${index}`} style={stack}><strong>{name}</strong>
      <Select name={`check-${index}`} label={`${name}: result`} value="skipped" options={["skipped", "passed", "failed"].map((value) => ({ value, label: value }))} />
      <EvidenceFields name={`check-evidence-${index}`} />
    </div>)}
    {improvement.evaluationSpec.metrics.map((metric, index) => <div key={metric.name} style={stack}>
      <strong>{metric.name}</strong><p style={muted}>{metric.direction === "increase" ? "Higher" : "Lower"} is better. Required improvement: {metric.minimumImprovement ?? "none"}; maximum permitted regression: {metric.maxRegression}.</p>
      <Select name={`metric-${index}`} label={`${metric.name}: result`} value="skipped" options={["skipped", "passed", "failed"].map((value) => ({ value, label: value }))} />
      <Field name={`baseline-${index}`} label={`${metric.name}: baseline value`} type="number" step="any" required={false} />
      <Field name={`candidate-${index}`} label={`${metric.name}: candidate value`} type="number" step="any" required={false} />
      <EvidenceFields name={`metric-evidence-${index}`} />
    </div>)}
  </Form>;
}
function Improvements({ state, run, busy }: ViewProps) {
  const active = state.policies.find((policy) => policy.id === state.activePolicyId);
  return <>
    <Section title="Propose an instruction improvement" description="Compare a candidate with the active baseline using a frozen benefit target, required checks and a limited number of trials.">
      {!active ? <p style={muted}>Publish the initial instruction version before proposing an improvement.</p> : <Form key={active.id} label="Freeze proposal and evaluation specification" busy={busy} run={run} command={(data) => ({ type: "improvement.propose", id: id(), title: text(data, "title"), baselinePolicyId: active.id, candidatePolicyId: id(), bundle: readBundle(data), maxTrials: number(data, "trials"), evaluationSpec: {
        checks: lines(data, "checks"), nonRegressionChecks: lines(data, "regression-checks"), metrics: [{ name: text(data, "metric"), direction: text(data, "direction") as "increase" | "decrease", minimumImprovement: number(data, "minimum-improvement"), maxRegression: number(data, "maximum-regression") }],
      } })}>
        <Field name="title" label="Improvement and expected benefit" /><BundleFields bundle={active.bundle} />
        <Field name="checks" label="Required checks" multiline help="One check name per line. All must pass." />
        <Field name="regression-checks" label="Non-regression checks" multiline help="One additional guardrail per line. Include at least one." />
        <Field name="metric" label="Benefit metric" help="Use a measurable outcome, such as time to finish the same task or accepted outcomes." />
        <Select name="direction" label="Better means" options={[{ value: "increase", label: "A higher value" }, { value: "decrease", label: "A lower value" }]} />
        <Field name="minimum-improvement" label="Minimum improvement over baseline" type="number" min={0} step="any" help="Enter a positive improvement; matching the baseline is insufficient for promotion." />
        <Field name="maximum-regression" label="Maximum permitted regression" type="number" min={0} step="any" value={0} />
        <Field name="trials" label="Maximum evaluation trials" type="number" min={1} max={3} step="1" value={3} />
      </Form>}
    </Section>
    <Section title="Improvement register">
      {state.improvements.length === 0 && <p style={muted}>No proposals recorded. Leave the active version in place until a change has a specific benefit.</p>}
      {state.improvements.slice().reverse().map((improvement) => <details key={improvement.id}><summary>{improvement.title} · {improvement.promotedAt ? "Promoted" : `${improvement.evaluations.length}/${improvement.maxTrials} evaluations`}</summary><div style={stack}>
        <p style={mono}>Baseline {improvement.baselinePolicyId}<br />Candidate {improvement.candidatePolicyId}</p>
        {improvement.evaluations.map((evaluation, index) => <details key={index}><summary>Evaluation {index + 1}: {evaluation.passed ? "Recorded criteria passed" : "Recorded criteria not passed"}</summary>
          <div style={stack}><p>Evaluator {evaluation.evaluatorId} · run <span style={mono}>{evaluation.runRef}</span></p>
            <p style={muted}>Recorded by {evaluation.actor.kind} {evaluation.actor.id} at {timestamp(evaluation.at)}.</p>
            {evaluation.checks.map((check, checkIndex) => <div key={checkIndex}><strong>{check.name}: {check.status}</strong><EvidenceList refs={check.evidenceRefs} /></div>)}
            {evaluation.metrics.map((metric, metricIndex) => <div key={metricIndex}><strong>{metric.name}: {metric.status}</strong><p>Baseline {metric.baseline ?? "unavailable"} → candidate {metric.candidate ?? "unavailable"}</p><EvidenceList refs={metric.evidenceRefs} /></div>)}
          </div>
        </details>)}
        {!improvement.promotedAt && improvement.evaluations.length < improvement.maxTrials && <details><summary>Record an evaluation</summary><EvaluationForm improvement={improvement} run={run} busy={busy} /></details>}
        {!improvement.promotedAt && improvement.evaluations.at(-1)?.passed && <Form label="Promote and activate evaluated candidate" busy={busy} run={run} command={(data) => ({ type: "improvement.promote", improvementId: improvement.id, reason: text(data, "reason") })}>
          <Field name="reason" label="Reason to promote" /><p style={muted}>Promotion approves and activates this candidate. An earlier approved version remains available for rollback in Instructions.</p>
        </Form>}
        {!improvement.promotedAt && improvement.evaluations.length >= improvement.maxTrials && !improvement.evaluations.at(-1)?.passed && <p style={muted}>The trial limit has been reached without a passing final evaluation. The baseline remains available.</p>}
      </div></details>)}
    </Section>
  </>;
}

function CompanyControl({ companyId }: { companyId: string }) {
  const { data, loading, error, refresh } = usePluginData<{ revision: number; state: CompanyState }>("overview", { companyId });
  const commandAction = usePluginAction("command");
  const [tab, setTab] = useState<Tab>("Overview");
  const [pending, setPending] = useState(false);
  const [awaitingRevision, setAwaitingRevision] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    if (awaitingRevision !== null && (error || (data && data.revision !== awaitingRevision))) {
      setAwaitingRevision(null); locked.current = false;
    }
  }, [awaitingRevision, data, error]);
  const run: Run = async (command) => {
    if (!data || loading || locked.current) return false;
    locked.current = true; setPending(true); setActionError(null); setNotice(null);
    try {
      await commandAction({ companyId, expectedRevision: data.revision, command });
      setAwaitingRevision(data.revision); refresh(); setNotice("Saved. Refreshing company state…"); return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The action could not be saved. Refresh the company state and try again.");
      locked.current = false; refresh(); return false;
    } finally { setPending(false); }
  };
  const busy = pending || loading || awaitingRevision !== null;
  return <main style={{ ...stack, padding: "calc(var(--spacing) * 6)", color: "var(--foreground)", fontFamily: "var(--font-sans)" }}>
    <header style={stack}><h1 className="text-2xl font-semibold">Shared operations</h1><p style={muted}>Shared instructions, sourced context and bounded decisions for this company.</p></header>
    <nav aria-label="Operations sections" style={row}>{tabs.map((item) => <button key={item} type="button" aria-pressed={tab === item} style={tab === item ? button : secondary} onClick={() => setTab(item)}>{item}</button>)}</nav>
    <div style={row}><button type="button" style={secondary} disabled={pending || loading} onClick={() => { setNotice(null); refresh(); }}>Refresh</button>{data && <small style={muted}>Company revision <span style={mono}>{data.revision}</span></small>}</div>
    {loading && <p role="status">Loading company state…</p>}
    {error && <p role="alert" style={{ color: "var(--destructive)" }}>Could not load company state: {error.message}. Use Refresh to retry.</p>}
    {actionError && <p role="alert" style={{ color: "var(--destructive)" }}>{actionError}</p>}
    {notice && <p role="status" style={muted}>{awaitingRevision === null ? "Saved." : notice}</p>}
    {data && <div aria-busy={busy} style={stack}>
      {tab === "Overview" && <Overview state={data.state} go={setTab} />}
      {tab === "Instructions" && <Instructions state={data.state} run={run} busy={busy} />}
      {tab === "Memory" && <Memory state={data.state} run={run} busy={busy} companyId={companyId} />}
      {tab === "Decisions" && <Decisions state={data.state} run={run} busy={busy} />}
      {tab === "Improvement" && <Improvements state={data.state} run={run} busy={busy} />}
    </div>}
  </main>;
}
export function ControlPage({ context }: PluginPageProps) {
  return context.companyId ? <CompanyControl key={context.companyId} companyId={context.companyId} /> : <p>Select a company to open shared operations.</p>;
}
export function SidebarLink(_props: PluginSidebarProps) {
  const navigation = useHostNavigation();
  return <a {...navigation.linkProps("/shared-operations")} className="flex items-center gap-2 px-3 py-2 text-sm font-medium hover:bg-accent" style={{ color: "var(--foreground)", textDecoration: "none" }}>Shared operations</a>;
}
