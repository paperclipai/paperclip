import { createHash } from "node:crypto";

export interface Actor { id: string; kind: "board" | "agent" }
export interface EvidenceRef { ref: string; digest: string }
export interface PolicyBundle {
  instructions: string[];
  constraints: string[];
  skills: { name: string; content: string }[];
  /** Declarative guidance only; this plugin never executes hooks. */
  hooks: { event: string; instruction: string }[];
}
export interface Stamp { actor: Actor; at: string }
export interface PolicyVersion extends Stamp { id: string; bundle: PolicyBundle; digest: string }
export type MemoryStatus = "current" | "stale" | "contested" | "retired";
export interface MemoryRecord extends Stamp {
  id: string; title: string; content: string; provenanceRefs: EvidenceRef[];
  status: MemoryStatus; revision: number;
}
export type Outcome = "proceed" | "no_change" | "defer" | "escalate";
export interface Decision extends Stamp {
  id: string; title: string; ownerId: string; requirement: string;
  riskClass: "low" | "medium" | "high"; reversibility: "reversible" | "irreversible";
  impacts: ("external_publication" | "spend" | "account_change")[];
  requiredEvidenceRefs: string[]; evidenceRefs: EvidenceRef[]; maxRounds: number; deadline: string;
  consultations: (Stamp & { summary: string; evidenceRefs: EvidenceRef[] })[];
  resolution: (Stamp & { outcome: Outcome; reason: string; evidenceRefs: EvidenceRef[] }) | null;
  reopenHistory: (Stamp & { requirement: string; evidenceFingerprint: string; reason: string })[];
  evidenceFingerprint: string;
}
export interface ContextSnapshot extends Stamp {
  id: string; receiverId: string; taskId: string; taskRevision: string;
  policy: PolicyVersion; memories: MemoryRecord[]; omissions: { ref: string; reason: string }[];
  digest: string; receipt: (Stamp & { digest: string; taskRevision: string }) | null;
}
export interface EvaluationSpec {
  checks: string[]; nonRegressionChecks: string[];
  metrics: { name: string; direction: "increase" | "decrease"; minimumImprovement: number | null; maxRegression: number }[];
}
export type GateStatus = "passed" | "failed" | "skipped";
export interface EvaluationCheck { name: string; status: GateStatus; evidenceRefs: EvidenceRef[] }
export interface EvaluationMetric extends EvaluationCheck { baseline: number | null; candidate: number | null }
export interface Evaluation extends Stamp {
  baselinePolicyId: string; specHash: string; evaluatorId: string; runRef: string;
  checks: EvaluationCheck[]; metrics: EvaluationMetric[]; passed: boolean;
}
export interface Improvement extends Stamp {
  id: string; title: string; baselinePolicyId: string; candidatePolicyId: string;
  evaluationSpec: EvaluationSpec; specHash: string; maxTrials: number;
  evaluations: Evaluation[]; promotedAt: string | null;
}
export interface DomainEvent extends Stamp { type: Command["type"]; subjectId: string; reason: string | null; command: Command }
/** One company per persisted document; the host owns company access and CAS revision. */
export interface CompanyState {
  policies: PolicyVersion[]; approvedPolicyIds: string[]; activePolicyId: string | null;
  decisions: Decision[]; memories: MemoryRecord[]; snapshots: ContextSnapshot[];
  improvements: Improvement[]; events: DomainEvent[];
}
export type Command =
  | { type: "policy.publish"; id: string; bundle: PolicyBundle; reason: string }
  | { type: "policy.activate"; policyId: string; reason: string }
  | { type: "decision.create"; id: string; title: string; ownerId: string; requirement: string; riskClass: Decision["riskClass"]; reversibility: Decision["reversibility"]; impacts: Decision["impacts"]; requiredEvidenceRefs: string[]; evidenceRefs: EvidenceRef[]; maxRounds: number; deadline: string }
  | { type: "decision.consult"; decisionId: string; summary: string; evidenceRefs: EvidenceRef[] }
  | { type: "decision.resolve"; decisionId: string; outcome: Outcome; reason: string; evidenceRefs: EvidenceRef[] }
  | { type: "decision.reopen"; decisionId: string; requirement: string; evidenceRefs: EvidenceRef[]; reason: string; deadline: string }
  | { type: "memory.put"; id: string; title: string; content: string; provenanceRefs: EvidenceRef[]; expectedRevision: number | null }
  | { type: "memory.status"; memoryId: string; status: MemoryStatus; reason: string; expectedRevision: number }
  | { type: "context.snapshot"; id: string; receiverId: string; taskId: string; taskRevision: string; memoryIds: string[]; omissions: { ref: string; reason: string }[] }
  | { type: "context.receive"; snapshotId: string; digest: string; taskRevision: string }
  | { type: "improvement.propose"; id: string; title: string; baselinePolicyId: string; candidatePolicyId: string; bundle: PolicyBundle; evaluationSpec: EvaluationSpec; maxTrials: number }
  | { type: "improvement.evaluate"; improvementId: string; baselinePolicyId: string; specHash: string; evaluatorId: string; runRef: string; checks: EvaluationCheck[]; metrics: EvaluationMetric[] }
  | { type: "improvement.promote"; improvementId: string; reason: string };

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "DomainError";
  }
}

export function emptyState(): CompanyState {
  return { policies: [], approvedPolicyIds: [], activePolicyId: null, decisions: [], memories: [], snapshots: [], improvements: [], events: [] };
}

function requireThat(condition: unknown, code: string, message: string, status = 409): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}

type Parser = (value: unknown) => unknown;
function invalid(condition: unknown, message: string): asserts condition { requireThat(condition, "INVALID_INPUT", message, 400); }
function object(value: unknown): Record<string, unknown> {
  invalid(typeof value === "object" && value !== null && !Array.isArray(value), "Expected an object");
  invalid(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "Expected a plain object");
  return value as Record<string, unknown>;
}
function fields(value: unknown, schema: Record<string, Parser>): Record<string, unknown> {
  const source = object(value);
  invalid(Object.keys(source).every((key) => Object.hasOwn(schema, key)), "Unexpected field");
  return Object.fromEntries(Object.entries(schema).map(([key, parser]) => [key, parser(source[key])]));
}
const text = (max: number): Parser => (value) => {
  invalid(typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0"), `Expected non-empty text of at most ${max} characters`);
  return value.trim();
};
const id = text(200);
const short = text(500);
const long = text(8192);
const number: Parser = (value) => { invalid(typeof value === "number" && Number.isFinite(value), "Expected a finite number"); return value; };
const integer = (min: number, max: number): Parser => (value) => { number(value); invalid(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max, `Expected an integer between ${min} and ${max}`); return value; };
const nullable = (parser: Parser): Parser => (value) => value === null ? null : parser(value);
const enumeration = (...allowed: string[]): Parser => (value) => { invalid(typeof value === "string" && allowed.includes(value), `Expected one of ${allowed.join(", ")}`); return value; };
const list = (parser: Parser, min = 0, max = 20): Parser => (value) => {
  invalid(Array.isArray(value) && value.length >= min && value.length <= max, `Expected ${min} to ${max} items`);
  return value.map(parser);
};
const uniqueList = (parser: Parser, min = 0, max = 20): Parser => (value) => {
  const parsed = list(parser, min, max)(value) as unknown[];
  invalid(new Set(parsed.map((entry) => JSON.stringify(entry))).size === parsed.length, "Duplicate items are not allowed");
  return parsed;
};
const digest: Parser = (value) => { invalid(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "Expected a lowercase SHA-256 digest"); return value; };
const date: Parser = (value) => {
  const parsed = text(40)(value) as string;
  invalid(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(parsed) && Number.isFinite(Date.parse(parsed)), "Expected a UTC ISO timestamp");
  const canonical = new Date(parsed).toISOString();
  invalid(canonical.slice(0, 19) === parsed.slice(0, 19), "Expected a valid calendar date");
  return canonical;
};
const evidenceRefs = (min = 0): Parser => (value) => {
  const parsed = list((entry) => fields(entry, { ref: short, digest }), min)(value) as EvidenceRef[];
  invalid(new Set(parsed.map((entry) => entry.ref)).size === parsed.length, "Evidence references must be unique");
  return parsed;
};
const policyBundle: Parser = (value) => {
  const parsed = fields(value, {
    instructions: list(long, 1), constraints: list(long),
    skills: list((entry) => fields(entry, { name: id, content: long })),
    hooks: list((entry) => fields(entry, { event: id, instruction: long })),
  });
  invalid(Buffer.byteLength(JSON.stringify(parsed)) <= 32768, "Policy bundle exceeds 32 KiB");
  return parsed;
};
const evaluationSpec: Parser = (value) => {
  const parsed = fields(value, {
    checks: uniqueList(id, 1), nonRegressionChecks: uniqueList(id, 1),
    metrics: list((entry) => fields(entry, { name: id, direction: enumeration("increase", "decrease"), minimumImprovement: nullable(number), maxRegression: number }), 1),
  }) as unknown as EvaluationSpec;
  invalid(new Set([...parsed.checks, ...parsed.nonRegressionChecks]).size === parsed.checks.length + parsed.nonRegressionChecks.length, "Checks and non-regression checks must have distinct names");
  invalid(new Set(parsed.metrics.map((entry) => entry.name)).size === parsed.metrics.length, "Metric names must be unique");
  invalid(parsed.metrics.every((entry) => entry.maxRegression >= 0 && (entry.minimumImprovement === null || entry.minimumImprovement >= 0)), "Metric tolerances must be non-negative");
  invalid(parsed.metrics.some((entry) => entry.minimumImprovement !== null && entry.minimumImprovement > 0), "At least one metric must require a measurable improvement");
  return parsed;
};
const checkSchema = { name: id, status: enumeration("passed", "failed", "skipped"), evidenceRefs: evidenceRefs(1) };
const schemas: Record<Command["type"], Record<string, Parser>> = {
  "policy.publish": { id, bundle: policyBundle, reason: long },
  "policy.activate": { policyId: id, reason: long },
  "decision.create": { id, title: short, ownerId: id, requirement: long, riskClass: enumeration("low", "medium", "high"), reversibility: enumeration("reversible", "irreversible"), impacts: uniqueList(enumeration("external_publication", "spend", "account_change"), 0, 3), requiredEvidenceRefs: uniqueList(short, 1), evidenceRefs: evidenceRefs(), maxRounds: integer(1, 3), deadline: date },
  "decision.consult": { decisionId: id, summary: long, evidenceRefs: evidenceRefs() },
  "decision.resolve": { decisionId: id, outcome: enumeration("proceed", "no_change", "defer", "escalate"), reason: long, evidenceRefs: evidenceRefs() },
  "decision.reopen": { decisionId: id, requirement: long, evidenceRefs: evidenceRefs(), reason: long, deadline: date },
  "memory.put": { id, title: short, content: long, provenanceRefs: evidenceRefs(1), expectedRevision: nullable(integer(1, Number.MAX_SAFE_INTEGER)) },
  "memory.status": { memoryId: id, status: enumeration("current", "stale", "contested", "retired"), reason: long, expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) },
  "context.snapshot": { id, receiverId: id, taskId: id, taskRevision: id, memoryIds: uniqueList(id), omissions: list((entry) => fields(entry, { ref: short, reason: long })) },
  "context.receive": { snapshotId: id, digest, taskRevision: id },
  "improvement.propose": { id, title: short, baselinePolicyId: id, candidatePolicyId: id, bundle: policyBundle, evaluationSpec, maxTrials: integer(1, 3) },
  "improvement.evaluate": { improvementId: id, baselinePolicyId: id, specHash: digest, evaluatorId: id, runRef: short, checks: list((entry) => fields(entry, checkSchema), 0, 40), metrics: list((entry) => fields(entry, { ...checkSchema, baseline: nullable(number), candidate: nullable(number) })) },
  "improvement.promote": { improvementId: id, reason: long },
};
function parseCommand(value: unknown): Command {
  const source = object(value);
  invalid(typeof source.type === "string" && Object.hasOwn(schemas, source.type), "Unknown command type");
  return fields(source, { type: enumeration(source.type), ...schemas[source.type as Command["type"]] }) as unknown as Command;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function evidenceFingerprint(refs: EvidenceRef[]): string { return hash([...new Set(refs.map((ref) => ref.digest))].sort()); }
function find<T extends { id: string }>(records: T[], recordId: string): T {
  const record = records.find((entry) => entry.id === recordId);
  requireThat(record, "NOT_FOUND", `Record ${recordId} was not found`, 404);
  return record;
}
function unused(records: { id: string }[], recordId: string): void {
  requireThat(!records.some((entry) => entry.id === recordId), "DUPLICATE_ID", `Record ${recordId} already exists`);
}
function mergeEvidence(existing: EvidenceRef[], added: EvidenceRef[]): EvidenceRef[] {
  return [...new Map([...existing, ...added].map((entry) => [entry.ref, entry])).values()];
}

export function applyCommand(state: CompanyState, command: unknown, actor: Actor, now: string): CompanyState {
  const c = parseCommand(command);
  const stamp = { actor: fields(actor, { id, kind: enumeration("board", "agent") }) as unknown as Actor, at: date(now) as string };
  const next = structuredClone(state);
  const board = () => requireThat(actor.kind === "board", "BOARD_REQUIRED", "This action requires the board", 403);
  const owner = (decision: Decision) => requireThat(actor.kind === "board" || actor.id === decision.ownerId, "OWNER_REQUIRED", "Only the decision owner or board may do this", 403);
  const future = (deadline: string) => requireThat(Date.parse(deadline) > Date.parse(now), "INVALID_INPUT", "The deadline must be in the future", 400);
  const baseline = (policyId: string) => requireThat(next.activePolicyId === policyId, "STALE_BASELINE", "The active policy no longer matches this baseline");
  let subjectId: string;

  switch (c.type) {
    case "policy.publish": {
      board();
      requireThat(next.policies.length === 0, "POLICY_ALREADY_INITIALISED", "Propose and evaluate subsequent policy versions");
      next.policies.push({ id: c.id, bundle: c.bundle, digest: hash(c.bundle), ...stamp });
      next.approvedPolicyIds.push(c.id);
      next.activePolicyId = c.id;
      subjectId = c.id;
      break;
    }
    case "policy.activate": {
      board();
      find(next.policies, c.policyId);
      requireThat(next.approvedPolicyIds.includes(c.policyId), "UNAPPROVED_POLICY", "Only an approved historical policy can be activated");
      next.activePolicyId = c.policyId;
      subjectId = c.policyId;
      break;
    }
    case "decision.create": {
      unused(next.decisions, c.id);
      requireThat(actor.kind === "board" || actor.id === c.ownerId, "OWNER_REQUIRED", "An agent may only create its own decision", 403);
      future(c.deadline);
      const { type: _, ...data } = c;
      next.decisions.push({ ...data, ...stamp, consultations: [], resolution: null, reopenHistory: [], evidenceFingerprint: evidenceFingerprint(c.evidenceRefs) });
      subjectId = c.id;
      break;
    }
    case "decision.consult": {
      const decision = find(next.decisions, c.decisionId);
      requireThat(!decision.resolution, "DECISION_CLOSED", "This decision is already resolved");
      requireThat(decision.consultations.length < decision.maxRounds && Date.parse(now) < Date.parse(decision.deadline), "DEBATE_CLOSED", "Consultation has reached its deadline or round limit; resolve, defer or escalate");
      decision.consultations.push({ summary: c.summary, evidenceRefs: c.evidenceRefs, ...stamp });
      decision.evidenceRefs = mergeEvidence(decision.evidenceRefs, c.evidenceRefs);
      decision.evidenceFingerprint = evidenceFingerprint(decision.evidenceRefs);
      subjectId = c.decisionId;
      break;
    }
    case "decision.resolve": {
      const decision = find(next.decisions, c.decisionId);
      owner(decision);
      requireThat(!decision.resolution || (decision.resolution.outcome === "escalate" && actor.kind === "board"), "DECISION_CLOSED", "This decision is already resolved; the board may adjudicate an escalation");
      const refs = mergeEvidence(decision.evidenceRefs, c.evidenceRefs);
      if (c.outcome === "proceed") {
        if (decision.riskClass === "high" || decision.reversibility === "irreversible" || decision.impacts.length > 0) board();
        requireThat(decision.requiredEvidenceRefs.every((ref) => refs.some((entry) => entry.ref === ref)), "EVIDENCE_REQUIRED", "Required evidence references are missing", 422);
      }
      decision.evidenceRefs = refs;
      decision.evidenceFingerprint = evidenceFingerprint(refs);
      decision.resolution = { outcome: c.outcome, reason: c.reason, evidenceRefs: c.evidenceRefs, ...stamp };
      subjectId = c.decisionId;
      break;
    }
    case "decision.reopen": {
      const decision = find(next.decisions, c.decisionId);
      owner(decision);
      requireThat(decision.resolution, "DECISION_OPEN", "Only a resolved decision can be reopened");
      future(c.deadline);
      const fingerprint = evidenceFingerprint(c.evidenceRefs);
      const seen = [{ requirement: decision.requirement, evidenceFingerprint: decision.evidenceFingerprint }, ...decision.reopenHistory];
      requireThat(!seen.some((entry) => entry.requirement === c.requirement && entry.evidenceFingerprint === fingerprint), "NO_MATERIAL_CHANGE", "Reopening requires different material evidence or a changed requirement");
      requireThat(c.requirement !== decision.requirement || c.evidenceRefs.some((entry) => !decision.evidenceRefs.some((old) => old.digest === entry.digest)), "NO_MATERIAL_CHANGE", "Removing or renaming evidence is not a material change");
      decision.reopenHistory.push({ requirement: decision.requirement, evidenceFingerprint: decision.evidenceFingerprint, reason: c.reason, ...stamp });
      decision.requirement = c.requirement;
      decision.evidenceRefs = c.evidenceRefs;
      decision.evidenceFingerprint = fingerprint;
      decision.deadline = c.deadline;
      decision.consultations = [];
      decision.resolution = null;
      subjectId = c.decisionId;
      break;
    }
    case "memory.put": {
      const existing = next.memories.find((entry) => entry.id === c.id);
      requireThat((existing?.revision ?? null) === c.expectedRevision, "STALE_REVISION", "Memory revision has changed");
      const memory: MemoryRecord = { id: c.id, title: c.title, content: c.content, provenanceRefs: c.provenanceRefs, status: "current", revision: (existing?.revision ?? 0) + 1, ...stamp };
      if (existing) next.memories[next.memories.indexOf(existing)] = memory;
      else next.memories.push(memory);
      subjectId = c.id;
      break;
    }
    case "memory.status": {
      const memory = find(next.memories, c.memoryId);
      requireThat(memory.revision === c.expectedRevision, "STALE_REVISION", "Memory revision has changed");
      Object.assign(memory, stamp, { status: c.status, revision: memory.revision + 1 });
      subjectId = c.memoryId;
      break;
    }
    case "context.snapshot": {
      unused(next.snapshots, c.id);
      requireThat(next.activePolicyId, "POLICY_REQUIRED", "Activate a policy before creating shared context");
      const memories = c.memoryIds.map((memoryId) => find(next.memories, memoryId));
      requireThat(memories.every((memory) => memory.status === "current"), "MEMORY_NOT_CURRENT", "Stale, contested and retired memories cannot be asserted as current context");
      const omissions = [...c.omissions];
      invalid(new Set(omissions.map((entry) => entry.ref)).size === omissions.length && !omissions.some((entry) => c.memoryIds.some((memoryId) => entry.ref === `memory:${memoryId}`)), "Omissions must be unique and must not describe included records");
      for (const memory of next.memories) {
        if (!c.memoryIds.includes(memory.id) && !omissions.some((entry) => entry.ref === `memory:${memory.id}`)) omissions.push({ ref: `memory:${memory.id}`, reason: "Not selected for this context snapshot" });
      }
      const payload = { id: c.id, receiverId: c.receiverId, taskId: c.taskId, taskRevision: c.taskRevision, policy: find(next.policies, next.activePolicyId), memories, omissions, ...stamp };
      requireThat(Buffer.byteLength(JSON.stringify(payload)) <= 32768, "CONTEXT_TOO_LARGE", "Select less context; snapshots are limited to 32 KiB", 422);
      next.snapshots.push(structuredClone({ ...payload, digest: hash(payload), receipt: null }));
      subjectId = c.id;
      break;
    }
    case "context.receive": {
      const snapshot = find(next.snapshots, c.snapshotId);
      requireThat(actor.id === snapshot.receiverId, "RECEIVER_REQUIRED", "Only the intended receiver may acknowledge this snapshot", 403);
      requireThat(c.digest === snapshot.digest, "SNAPSHOT_MISMATCH", "Receipt digest does not match the exact snapshot");
      requireThat(!snapshot.receipt, "ALREADY_RECEIVED", "This snapshot has already been acknowledged");
      requireThat(snapshot.taskRevision === c.taskRevision && snapshot.policy.id === next.activePolicyId && snapshot.memories.every((memory) => next.memories.some((current) => current.id === memory.id && current.revision === memory.revision && current.status === "current")), "STALE_CONTEXT", "Task, active policy or selected memory has changed; create a fresh snapshot");
      snapshot.receipt = { digest: c.digest, taskRevision: c.taskRevision, ...stamp };
      subjectId = c.snapshotId;
      break;
    }
    case "improvement.propose": {
      baseline(c.baselinePolicyId);
      unused(next.improvements, c.id);
      unused(next.policies, c.candidatePolicyId);
      requireThat(!next.improvements.some((entry) => entry.baselinePolicyId === c.baselinePolicyId && find(next.policies, entry.candidatePolicyId).digest === hash(c.bundle)), "DUPLICATE_CANDIDATE", "Renaming an identical candidate or changing its evaluation does not reset its trial budget");
      next.policies.push({ id: c.candidatePolicyId, bundle: c.bundle, digest: hash(c.bundle), ...stamp });
      next.improvements.push({ id: c.id, title: c.title, baselinePolicyId: c.baselinePolicyId, candidatePolicyId: c.candidatePolicyId, evaluationSpec: c.evaluationSpec, specHash: hash(c.evaluationSpec), maxTrials: c.maxTrials, evaluations: [], promotedAt: null, ...stamp });
      subjectId = c.id;
      break;
    }
    case "improvement.evaluate": {
      board();
      const improvement = find(next.improvements, c.improvementId);
      baseline(improvement.baselinePolicyId);
      requireThat(c.baselinePolicyId === improvement.baselinePolicyId, "STALE_BASELINE", "Evaluation baseline does not match the proposal");
      requireThat(c.specHash === improvement.specHash, "SPEC_MISMATCH", "Evaluation specification has changed");
      requireThat(c.evaluatorId !== improvement.actor.id, "EVALUATOR_COLLISION", "The evaluator must differ from the improvement creator", 403);
      requireThat(!improvement.promotedAt, "ALREADY_PROMOTED", "This improvement was already promoted");
      requireThat(improvement.evaluations.length < improvement.maxTrials, "TRIAL_LIMIT", "This improvement has exhausted its trial budget");
      requireThat(!next.improvements.some((entry) => entry.evaluations.some((evaluation) => evaluation.runRef === c.runRef)), "RUN_ALREADY_RECORDED", "An evaluator run may only be recorded once");
      const namesMatch = (actual: { name: string }[], expected: string[]) => actual.length === expected.length && new Set(actual.map((entry) => entry.name)).size === actual.length && expected.every((name) => actual.some((entry) => entry.name === name));
      const spec = improvement.evaluationSpec;
      requireThat(namesMatch(c.checks, [...spec.checks, ...spec.nonRegressionChecks]) && namesMatch(c.metrics, spec.metrics.map((metric) => metric.name)), "GATES_MISMATCH", "Supply every evaluation check, non-regression check and metric exactly once", 422);
      const passed = c.checks.every((check) => check.status === "passed") && spec.metrics.every((metric) => {
        const result = c.metrics.find((entry) => entry.name === metric.name)!;
        if (result.status !== "passed" || result.baseline === null || result.candidate === null) return false;
        const delta = metric.direction === "increase" ? result.candidate - result.baseline : result.baseline - result.candidate;
        return Number.isFinite(delta) && delta >= -metric.maxRegression && (metric.minimumImprovement === null || delta >= metric.minimumImprovement);
      });
      improvement.evaluations.push({ baselinePolicyId: c.baselinePolicyId, specHash: c.specHash, evaluatorId: c.evaluatorId, runRef: c.runRef, checks: c.checks, metrics: c.metrics, passed, ...stamp });
      subjectId = c.improvementId;
      break;
    }
    case "improvement.promote": {
      board();
      const improvement = find(next.improvements, c.improvementId);
      baseline(improvement.baselinePolicyId);
      requireThat(!improvement.promotedAt, "ALREADY_PROMOTED", "This improvement was already promoted");
      const latest = improvement.evaluations.at(-1);
      requireThat(latest?.passed && latest.specHash === improvement.specHash && latest.baselinePolicyId === improvement.baselinePolicyId, "EVALUATION_REQUIRED", "The latest trusted evaluation must pass all gates against this baseline");
      improvement.promotedAt = now;
      next.approvedPolicyIds.push(improvement.candidatePolicyId);
      next.activePolicyId = improvement.candidatePolicyId;
      subjectId = c.improvementId;
      break;
    }
  }
  next.events.push({ type: c.type, subjectId, reason: "reason" in c ? c.reason : null, command: c, ...stamp });
  return next;
}
