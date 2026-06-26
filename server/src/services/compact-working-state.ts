type UnknownRecord = Record<string, unknown>;

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

  return {
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
  };
}

export function isStaleCompactWorkingStatePacket(
  packet: CompactWorkingStateSource,
  current: CompactWorkingStateSource,
): boolean {
  return packet.sourceRunId !== current.sourceRunId || packet.sourceSessionId !== current.sourceSessionId;
}
