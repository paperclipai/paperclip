import path from "node:path";
import { createHash } from "node:crypto";
import type { PlanRow } from "./plan-task-scoring.js";
import type { PlanSkillSource } from "./plan-task-skills.js";

export type PlanInvocation = { name: string; assetDigest: string };

/** Native context uses one immutable SKILL.md file for each company copy. */
export function planInvocations(sources: PlanSkillSource[], snapshot: PlanRow): PlanInvocation[] {
  return sources.filter(s => s.selected).map(source => {
    const entries = snapshot.entries?.filter((e: PlanRow) => e.key === source.key && e.desired);
    const entry = entries?.length === 1 ? entries[0] : undefined;
    if (!entry || !/^[a-zA-Z0-9_-]+$/.test(entry.runtimeName)) throw new Error("Missing unique assigned planning runtime name");
    const manifest = [{ path: "SKILL.md", sha256: source.sha256, mode: 0o444, size: source.bytes }];
    return { name: entry.runtimeName, assetDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
  });
}

export function planInvocationPrompt(prompt: string, invocations: PlanInvocation[]) {
  return invocations.length ? `${prompt}\n\nUse the assigned planning guidance: ${invocations.map(s => `/${s.name}`).join(" and ")}.` : prompt;
}

/** Exact initial lead run identity; provider turn acceptance joins its actual turn ID.
 * turn.submitted is emitted before the provider assigns that ID, so its skill
 * receipt establishes submission within this run, not a provider call-ID join. */
export function planExposure(input: { runs: PlanRow[]; evidence: PlanRow[]; leadId: string; parentId: string; invocations: PlanInvocation[] }) {
  const initial = input.runs.filter(r => r.agentId === input.leadId && r.nativeIssueId === input.parentId)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
  const records = input.evidence.filter(r => r.runId === initial?.id);
  const events: PlanRow[] = records.length === 1 && Array.isArray(records[0].events) ? records[0].events : [];
  const submitted = events.filter(e => e.runId === initial?.id && e.eventType === "turn.submitted");
  const prp = submitted.length === 1 ? submitted[0].payload?.prpEvent : undefined;
  const actual = prp?.payload?.skillInputs ?? [];
  const accepts = events.filter(e => e.runId === initial?.id && e.eventType === "turn.accepted");
  const acceptedTurn = accepts.length === 1 ? accepts[0].payload?.prpEvent : undefined;
  const accepted = typeof acceptedTurn?.turnId === "string" && acceptedTurn.turnId.length > 0 &&
    acceptedTurn.payload?.turnId === acceptedTurn.turnId && events.some(e => e.runId === initial?.id && e.eventType === "turn.started" &&
      e.payload?.prpEvent?.turnId === acceptedTurn.turnId);
  const expected = input.invocations;
  const matched = Array.isArray(actual) && actual.length === expected.length && expected.every(wanted => actual.filter((s: PlanRow) =>
    s.type === "skill" && s.name === wanted.name && typeof s.path === "string" &&
    path.isAbsolute(s.path) && s.path.endsWith(`/runtime-context-assets/bundles/${wanted.assetDigest}/SKILL.md`)).length === 1);
  return { id: "assigned-guidance-delivered", passed: Boolean(initial && prp && accepted && matched),
    detail: `Initial lead run must submit exactly ${expected.length} native skill inputs tied to the verified immutable file digests, and have a provider-accepted turn. This verifies the submission contract, not model consumption.`,
    selectedCount: expected.length, observedInputCount: Array.isArray(actual) ? actual.length : null };
}
