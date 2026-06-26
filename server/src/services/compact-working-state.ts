type UnknownRecord = Record<string, unknown>;

const BASE_STATUSES = ["approved", "rejected", "blocked", "done", "in_progress"] as const;
const ACCEPTANCE_STATUSES = [
  "pending",
  "in_progress",
  "asserted_passed",
  "asserted_failed",
  "verified_passed",
  "verified_failed",
  "blocked",
] as const;
const CHANGE_STATUSES = ["added", "modified", "deleted", "renamed", "unchanged", "unknown"] as const;
const TEST_ARTIFACT_STATUSES = ["added", "modified", "deleted", "unchanged", "unknown"] as const;
const TEST_KINDS = ["unit", "integration", "e2e", "fixture", "contract", "unknown"] as const;
const TEST_RUN_RESULTS = ["not_run", "asserted_passed", "asserted_failed", "verified_passed", "verified_failed"] as const;
const ASSERTED_BY_VALUES = ["agent", "builder", "unknown"] as const;
const RAW_TRANSCRIPT_FORBIDDEN_KEYS = ["body", "content", "messages", "transcript"] as const;

type SemanticSelfReport = {
  stage?: unknown;
  status?: unknown;
  workingNotes?: unknown;
  acceptance?: unknown;
  tests?: unknown;
  blocker?: unknown;
  requiredHandoff?: unknown;
  next?: unknown;
};

export type BuildCompactWorkingStatePacketInput = {
  issue?: {
    identifier?: unknown;
    id?: unknown;
    objective?: unknown;
  };
  currentRun?: {
    id?: unknown;
  };
  persistedSession?: {
    id?: unknown;
  };
  currentAgent?: {
    role?: unknown;
    name?: unknown;
  };
  stage?: unknown;
  selfReport?: SemanticSelfReport;
  observedChanges?: unknown;
  artifacts?: unknown;
  rawTranscriptRefs?: unknown;
  requireWorkingNotes?: boolean;
};

export type CompactWorkingStateSource = {
  sourceRunId?: unknown;
  sourceSessionId?: unknown;
};

export type CompactWorkingStatePacket = UnknownRecord & {
  sourceRunId: string;
  sourceSessionId: string;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const text = readNonEmptyString(value);
  if (!text) throw new Error(`Missing ${field}`);
  return text;
}

function requireSelfReport(input: BuildCompactWorkingStatePacketInput): SemanticSelfReport {
  if (!input.selfReport || typeof input.selfReport !== "object") {
    throw new Error("Missing self-report");
  }
  return input.selfReport;
}

function requireSelfReportedField<T>(selfReport: SemanticSelfReport, field: keyof SemanticSelfReport): T {
  const value = selfReport[field];
  if (value === undefined) throw new Error(`Missing self-report ${String(field)}`);
  return value as T;
}

function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Missing ${field}`);
  return value;
}

function requireObject(value: unknown, field: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Missing ${field}`);
  }
  return value as UnknownRecord;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Field "${field}" must be a boolean`);
  return value;
}

function requireOneOf<T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  const text = requireNonEmptyString(value, field);
  if (!allowed.includes(text)) {
    throw new Error(`Field "${field}" must be one of ${allowed.join(", ")}`);
  }
  return text;
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Field "${field}" must be a string`);
  }
}

function validateStringArray(value: unknown, field: string): void {
  const entries = readArray(value, field);
  for (let i = 0; i < entries.length; i += 1) {
    if (typeof entries[i] !== "string") throw new Error(`Field "${field}[${i}]" must be a string`);
  }
}

function isAllowedEvidenceRef(ref: string): boolean {
  return ref.startsWith("paperclip:run:") ||
    ref.startsWith("paperclip:comment:") ||
    ref.startsWith("paperclip:document:") ||
    ref.startsWith("git:commit:") ||
    ref.startsWith("git:file:") ||
    ref === "git:diff" ||
    ref.startsWith("local-log:");
}

function hasVerifiedEvidence(evidence: unknown[]): boolean {
  return evidence.some((entry) => requireObject(entry, "evidence").verified === true);
}

function validateEvidenceRefs(value: unknown, field: string, opts: { requireVerified?: boolean } = {}): unknown[] {
  const evidence = readArray(value, field);
  for (let i = 0; i < evidence.length; i += 1) {
    const entry = requireObject(evidence[i], `${field}[${i}]`);
    requireNonEmptyString(entry.kind, `${field}[${i}].kind`);
    const ref = requireNonEmptyString(entry.ref, `${field}[${i}].ref`);
    if (!isAllowedEvidenceRef(ref)) throw new Error(`Field "${field}[${i}].ref" has an unsupported evidence prefix`);
    requireBoolean(entry.verified, `${field}[${i}].verified`);
    requireOptionalString(entry.label, `${field}[${i}].label`);
    requireOptionalString(entry.detail, `${field}[${i}].detail`);
  }
  if (opts.requireVerified && !hasVerifiedEvidence(evidence)) {
    throw new Error(`Field "${field}" requires at least one verified evidence ref`);
  }
  return evidence;
}

function validateArtifacts(value: unknown, field: string): void {
  const artifacts = readArray(value, field);
  for (let i = 0; i < artifacts.length; i += 1) {
    const artifact = requireObject(artifacts[i], `${field}[${i}]`);
    requireNonEmptyString(artifact.kind, `${field}[${i}].kind`);
    requireNonEmptyString(artifact.ref, `${field}[${i}].ref`);
    if (artifact.files !== undefined) validateStringArray(artifact.files, `${field}[${i}].files`);
  }
}

function validateDecision(value: unknown): void {
  const decision = requireObject(value, "decision");
  requireNonEmptyString(decision.code, "decision.code");
  if (decision.files !== undefined) validateStringArray(decision.files, "decision.files");
}

function validateAcceptance(value: unknown): void {
  const acceptance = readArray(value, "acceptance");
  for (let i = 0; i < acceptance.length; i += 1) {
    const item = requireObject(acceptance[i], `acceptance[${i}]`);
    requireNonEmptyString(item.id, `acceptance[${i}].id`);
    requireNonEmptyString(item.text, `acceptance[${i}].text`);
    const status = requireOneOf(item.status, `acceptance[${i}].status`, ACCEPTANCE_STATUSES);
    requireOneOf(item.assertedBy, `acceptance[${i}].assertedBy`, ASSERTED_BY_VALUES);
    const verified = requireBoolean(item.verified, `acceptance[${i}].verified`);
    validateEvidenceRefs(item.evidence, `acceptance[${i}].evidence`, {
      requireVerified: verified || status === "verified_passed" || status === "verified_failed",
    });
    if ((status === "verified_passed" || status === "verified_failed") && !verified) {
      throw new Error(`Field "acceptance[${i}].verified" must be true for ${status}`);
    }
  }
}

function validateChanges(value: unknown): void {
  const changes = requireObject(value, "changes");
  const files = readArray(changes.files, "changes.files");
  for (let i = 0; i < files.length; i += 1) {
    const file = requireObject(files[i], `changes.files[${i}]`);
    requireNonEmptyString(file.path, `changes.files[${i}].path`);
    const status = requireOneOf(file.status, `changes.files[${i}].status`, CHANGE_STATUSES);
    const verified = requireBoolean(file.verified, `changes.files[${i}].verified`);
    if (file.previousPath !== undefined) {
      requireNonEmptyString(file.previousPath, `changes.files[${i}].previousPath`);
      if (status !== "renamed") {
        throw new Error(`Field "changes.files[${i}].previousPath" is allowed only when status is renamed`);
      }
    } else if (status === "renamed") {
      throw new Error(`Missing changes.files[${i}].previousPath`);
    }
    validateEvidenceRefs(file.evidence, `changes.files[${i}].evidence`, { requireVerified: verified });
  }

  const commits = readArray(changes.commits, "changes.commits");
  for (let i = 0; i < commits.length; i += 1) {
    const commit = requireObject(commits[i], `changes.commits[${i}]`);
    requireNonEmptyString(commit.sha, `changes.commits[${i}].sha`);
    requireOptionalString(commit.summary, `changes.commits[${i}].summary`);
    const verified = requireBoolean(commit.verified, `changes.commits[${i}].verified`);
    validateEvidenceRefs(commit.evidence, `changes.commits[${i}].evidence`, { requireVerified: verified });
  }
}

function validateTests(value: unknown): void {
  const tests = requireObject(value, "tests");
  const written = readArray(tests.written, "tests.written");
  for (let i = 0; i < written.length; i += 1) {
    const item = requireObject(written[i], `tests.written[${i}]`);
    requireNonEmptyString(item.path, `tests.written[${i}].path`);
    requireOneOf(item.kind, `tests.written[${i}].kind`, TEST_KINDS);
    requireOneOf(item.status, `tests.written[${i}].status`, TEST_ARTIFACT_STATUSES);
    const verified = requireBoolean(item.verified, `tests.written[${i}].verified`);
    validateEvidenceRefs(item.evidence, `tests.written[${i}].evidence`, { requireVerified: verified });
  }

  const runs = readArray(tests.runs, "tests.runs");
  for (let i = 0; i < runs.length; i += 1) {
    const run = requireObject(runs[i], `tests.runs[${i}]`);
    requireNonEmptyString(run.command, `tests.runs[${i}].command`);
    const result = requireOneOf(run.result, `tests.runs[${i}].result`, TEST_RUN_RESULTS);
    requireOneOf(run.assertedBy, `tests.runs[${i}].assertedBy`, ASSERTED_BY_VALUES);
    const verified = requireBoolean(run.verified, `tests.runs[${i}].verified`);
    validateEvidenceRefs(run.evidence, `tests.runs[${i}].evidence`, {
      requireVerified: verified || result === "verified_passed" || result === "verified_failed",
    });
    if ((result === "verified_passed" || result === "verified_failed") && !verified) {
      throw new Error(`Field "tests.runs[${i}].verified" must be true for ${result}`);
    }
  }
}

function validateRequiredHandoff(value: unknown): void {
  const handoff = requireObject(value, "requiredHandoff");
  const required = requireBoolean(handoff.required, "requiredHandoff.required");
  if (required) {
    requireNonEmptyString(handoff.to, "requiredHandoff.to");
    requireNonEmptyString(handoff.reason, "requiredHandoff.reason");
  } else if (handoff.to !== null || handoff.reason !== null) {
    throw new Error("requiredHandoff.to and requiredHandoff.reason must be null when required is false");
  }
  requireOneOf(handoff.status, "requiredHandoff.status", BASE_STATUSES);
}

function validateBlocker(value: unknown): void {
  if (value === null) return;
  const blocker = requireObject(value, "blocker");
  requireNonEmptyString(blocker.summary, "blocker.summary");
  if (blocker.owner !== undefined && blocker.owner !== null) {
    requireNonEmptyString(blocker.owner, "blocker.owner");
  }
  validateEvidenceRefs(blocker.evidence, "blocker.evidence");
}

function validateRawTranscriptRefs(value: unknown): void {
  const refs = readArray(value, "rawTranscriptRefs");
  for (let i = 0; i < refs.length; i += 1) {
    const ref = requireObject(refs[i], `rawTranscriptRefs[${i}]`);
    const refValue = requireNonEmptyString(ref.ref, `rawTranscriptRefs[${i}].ref`);
    if (!isAllowedEvidenceRef(refValue)) {
      throw new Error(`Field "rawTranscriptRefs[${i}].ref" has an unsupported evidence prefix`);
    }
    if (ref.replayByDefault !== false) {
      throw new Error(`Field "rawTranscriptRefs[${i}].replayByDefault" must be false`);
    }
    for (const key of RAW_TRANSCRIPT_FORBIDDEN_KEYS) {
      if (key in ref) throw new Error(`Field "rawTranscriptRefs[${i}].${key}" is not allowed`);
    }
  }
}

export function validateCompactWorkingStatePacket(packet: UnknownRecord): CompactWorkingStatePacket {
  if (packet.v !== 1) throw new Error("Field \"v\" must equal 1");
  if (packet.packetKind !== "compact_working_state") {
    throw new Error("Field \"packetKind\" must equal compact_working_state");
  }
  requireNonEmptyString(packet.issue, "issue");
  requireNonEmptyString(packet.issueId, "issueId");
  requireNonEmptyString(packet.sourceRunId, "sourceRunId");
  requireNonEmptyString(packet.sourceSessionId, "sourceSessionId");
  requireNonEmptyString(packet.stage, "stage");
  requireNonEmptyString(packet.from, "from");
  requireNonEmptyString(packet.to, "to");
  const status = requireOneOf(packet.status, "status", BASE_STATUSES);
  requireNonEmptyString(packet.objective, "objective");
  if (typeof packet.workingNotes !== "string") throw new Error("Field \"workingNotes\" must be a string");
  if (packet.workingNotes.length > 1500) throw new Error("Field \"workingNotes\" must be at most 1500 characters");
  if (status === "blocked" && packet.blocker === null) throw new Error("blocked status requires blocker");
  if (status !== "blocked" && packet.blocker !== null) throw new Error("blocker requires blocked status");

  validateAcceptance(packet.acceptance);
  validateChanges(packet.changes);
  validateTests(packet.tests);
  validateBlocker(packet.blocker);
  validateRequiredHandoff(packet.requiredHandoff);
  validateArtifacts(packet.artifacts, "artifacts");
  if (packet.decision !== undefined) validateDecision(packet.decision);
  validateRawTranscriptRefs(packet.rawTranscriptRefs);
  requireNonEmptyString(packet.next, "next");

  return packet as CompactWorkingStatePacket;
}

function readStatus(selfReport: SemanticSelfReport, blocker: unknown, requiredHandoff: unknown): string {
  const reportedStatus = readNonEmptyString(selfReport.status);
  if (reportedStatus) return reportedStatus;
  if (blocker !== null) return "blocked";

  const handoff = requiredHandoff && typeof requiredHandoff === "object" && !Array.isArray(requiredHandoff)
    ? requiredHandoff as UnknownRecord
    : null;
  return readNonEmptyString(handoff?.status) ?? "in_progress";
}

export function buildCompactWorkingStatePacket(
  input: BuildCompactWorkingStatePacketInput,
): CompactWorkingStatePacket {
  const selfReport = requireSelfReport(input);
  const issue = requireObject(input.issue, "issue");
  const role = requireNonEmptyString(input.currentAgent?.role, "currentAgent.role");
  const workingNotes = requireSelfReportedField<string>(selfReport, "workingNotes");
  if (typeof workingNotes !== "string") throw new Error("Missing self-report workingNotes");
  if (input.requireWorkingNotes && workingNotes.length === 0) {
    throw new Error("Missing self-report workingNotes");
  }
  if (workingNotes.length > 1500) throw new Error("workingNotes exceeds 1500 characters");

  const stage = readNonEmptyString(input.stage) ?? readNonEmptyString(selfReport.stage);
  if (!stage) throw new Error("Missing stage or self-report stage");

  const blocker = requireSelfReportedField<unknown>(selfReport, "blocker");
  const requiredHandoff = requireSelfReportedField<unknown>(selfReport, "requiredHandoff");
  const status = readStatus(selfReport, blocker, requiredHandoff);
  if (status === "blocked" && blocker === null) throw new Error("blocked status requires blocker");
  if (status !== "blocked" && blocker !== null) throw new Error("blocker requires blocked status");

  return validateCompactWorkingStatePacket({
    v: 1,
    packetKind: "compact_working_state",
    issue: requireNonEmptyString(issue.identifier, "issue.identifier"),
    issueId: requireNonEmptyString(issue.id, "issue.id"),
    sourceRunId: requireNonEmptyString(input.currentRun?.id, "currentRun.id"),
    sourceSessionId: requireNonEmptyString(input.persistedSession?.id, "persistedSession.id"),
    stage,
    from: role,
    to: role,
    status,
    objective: requireNonEmptyString(issue.objective, "issue.objective"),
    workingNotes,
    acceptance: readArray(requireSelfReportedField(selfReport, "acceptance"), "self-report acceptance"),
    changes: requireObject(input.observedChanges, "observedChanges"),
    tests: requireObject(requireSelfReportedField(selfReport, "tests"), "self-report tests"),
    blocker,
    requiredHandoff: requireObject(requiredHandoff, "self-report requiredHandoff"),
    artifacts: readArray(input.artifacts ?? [], "artifacts"),
    rawTranscriptRefs: readArray(input.rawTranscriptRefs ?? [], "rawTranscriptRefs"),
    next: requireNonEmptyString(requireSelfReportedField(selfReport, "next"), "self-report next"),
  });
}

export function buildCompactWorkingStateHandoffMarkdown(
  input: BuildCompactWorkingStatePacketInput,
): string | null {
  if (!input.selfReport || typeof input.selfReport !== "object") {
    return null;
  }
  const packet = buildCompactWorkingStatePacket(input);
  return `\`\`\`handoff-v1\n${JSON.stringify(packet, null, 2)}\n\`\`\``;
}

export function isStaleCompactWorkingStatePacket(
  packet: CompactWorkingStateSource,
  current: CompactWorkingStateSource,
): boolean {
  return packet.sourceRunId !== current.sourceRunId || packet.sourceSessionId !== current.sourceSessionId;
}
