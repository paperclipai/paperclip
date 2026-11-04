import type { RunnerE2EResult } from "./types.js";

export const DEPENDABLE_JOURNEYS = [
  "repository-result", "automatic-repository", "legacy-conversion",
  "necessary-question", "finalization-restart", "followup-stop-resume",
] as const;
export type DependableJourney = typeof DEPENDABLE_JOURNEYS[number];
export type DependableProvider = "codie" | "claude";
export type DependableSurface = "paperclip" | "slack";
export type DependableCell = `${DependableProvider}.${DependableSurface}.${DependableJourney}`;

export const DEPENDABLE_CELLS: readonly DependableCell[] = (["codie", "claude"] as const).flatMap(provider =>
  (["paperclip", "slack"] as const).flatMap(surface => DEPENDABLE_JOURNEYS.map(journey => `${provider}.${surface}.${journey}` as const)));

export function dependableExecutionId(cell: DependableCell) {
  if (!DEPENDABLE_CELLS.includes(cell)) throw new Error("Unknown dependable-work cell");
  const [provider, surface, journey] = cell.split(".");
  return `dependable-work.${provider}.daytona.${surface}-${journey}`;
}

const COMMON_CHECKS = ["durable-state", "rendered-conversation", "delivery-receipt", "independent-output"];
const JOURNEY_CHECKS: Record<DependableJourney, readonly string[]> = {
  "repository-result": ["repository-changes", "accessible-artifact"],
  "automatic-repository": ["automatic-continuation", "retained-workspace", "retained-context", "accessible-artifact"],
  "legacy-conversion": ["configuration-retained", "converted-runtime", "subsequent-work"],
  "necessary-question": ["necessary-question-visible", "context-visible", "answer-recorded", "one-continuation"],
  "finalization-restart": ["accepted-before-restart", "preserved-result", "no-provider-replay", "one-final-delivery"],
  "followup-stop-resume": ["followup-during-work", "stop-receipt", "no-work-after-stop", "retained-context", "resumed-result"],
};

export function dependableRequiredChecks(cell: DependableCell) {
  if (!DEPENDABLE_CELLS.includes(cell)) throw new Error("Unknown dependable-work cell");
  const journey = cell.split(".")[2] as DependableJourney;
  return [...COMMON_CHECKS, ...JOURNEY_CHECKS[journey]].map(id => `dependable.${id}`);
}

export interface DependableAttempt {
  campaignId: string;
  cell: DependableCell;
  phase: "candidate" | "staging";
  result: RunnerE2EResult;
  evidence: {
    manifestVerified: boolean;
    secretScanPassed: boolean;
    definitionHash: string;
    settingsHash: string;
    instructionsHash: string;
    runnerArtifact: string;
    revisionAtStart: string;
    revisionAtEnd: string;
    target: "isolated-candidate" | "isolated-staging";
  };
}

export interface DependableQualification {
  revision: string;
  startedAt: string;
  candidatePassesPerCell: 3;
  settingsHashes: Record<DependableProvider, string>;
  models: Record<DependableProvider, string>;
  instructionsHash: string;
  definitionHash: string;
  runnerArtifact: string;
}

const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
function time(value: string) { const n = Date.parse(value); return Number.isFinite(n) ? n : null; }

function attemptProblems(attempt: DependableAttempt, config: DependableQualification) {
  const { result, evidence, cell } = attempt;
  const problems: string[] = [];
  if (!DEPENDABLE_CELLS.includes(cell)) return ["unknown-cell"];
  const provider = cell.split(".")[0] as DependableProvider;
  if (result.executionId !== dependableExecutionId(cell) || result.suiteId !== "dependable-work" ||
    result.profileId !== provider || result.environmentId !== "daytona" || result.caseId !== cell.split(".").slice(1).join("-")) problems.push("wrong-core-cell");
  if (result.model !== config.models[provider] || result.provider !== (provider === "codie" ? "codex" : "acpx") || result.runtimeMode !== "native") problems.push("runtime-mismatch");
  if (result.status !== "passed") problems.push("failed-attempt");
  if (result.cleanup !== "passed") problems.push("cleanup-incomplete");
  if (!result.issueId || !result.runIds?.length || new Set(result.runIds).size !== result.runIds.length) problems.push("missing-or-duplicate-work-identity");
  const start = time(result.startedAt), finish = time(result.finishedAt);
  if (start === null || finish === null || finish < start || start < time(config.startedAt)!) problems.push("not-fresh");
  if (result.source?.sha !== config.revision || result.source.ref?.includes("(working tree)") || evidence.revisionAtStart !== config.revision || evidence.revisionAtEnd !== config.revision) problems.push("revision-mismatch-or-drift");
  if (result.suiteDefinitionHash !== config.definitionHash || evidence.definitionHash !== config.definitionHash) problems.push("definition-mismatch");
  if (evidence.settingsHash !== config.settingsHashes[provider]) problems.push("settings-mismatch");
  if (evidence.instructionsHash !== config.instructionsHash) problems.push("instructions-mismatch");
  if (evidence.runnerArtifact !== config.runnerArtifact) problems.push("runner-artifact-mismatch");
  if (!evidence.manifestVerified || !evidence.secretScanPassed) problems.push("evidence-unverified");
  if (evidence.target !== (attempt.phase === "staging" ? "isolated-staging" : "isolated-candidate")) problems.push("wrong-target");
  const checks = result.matcherResults ?? [];
  for (const required of dependableRequiredChecks(cell)) {
    const matching = checks.filter(check => check.matcher.kind === "json_path" && check.matcher.path === required && check.matcher.expected === true);
    if (matching.length !== 1 || !matching[0]!.passed) problems.push(`missing-or-failed:${required}`);
  }
  if (checks.some(check => !check.passed)) problems.push("failed-oracle");
  return problems;
}

export function gradeDependableQualification(config: DependableQualification, attempts: readonly DependableAttempt[]) {
  if (!sha.test(config.revision) || time(config.startedAt) === null || config.candidatePassesPerCell !== 3 ||
    !digest.test(config.definitionHash) || !digest.test(config.instructionsHash) ||
    !config.models.codie.trim() || !config.models.claude.trim() ||
    !digest.test(config.settingsHashes.codie) || !digest.test(config.settingsHashes.claude) ||
    !/^sha256:[a-f0-9]{64}$/.test(config.runnerArtifact)) throw new Error("Incomplete dependable-work qualification identity");
  const receipts = new Map<string, number>();
  const issues = new Map<string, number>();
  const runs = new Map<string, number>();
  for (const attempt of attempts) {
    const key = `${attempt.campaignId}:${attempt.result.executionId}:${attempt.result.attempt}`;
    receipts.set(key, (receipts.get(key) ?? 0) + 1);
    if (attempt.result.issueId) issues.set(attempt.result.issueId, (issues.get(attempt.result.issueId) ?? 0) + 1);
    for (const run of attempt.result.runIds ?? []) runs.set(run, (runs.get(run) ?? 0) + 1);
  }
  const observations = attempts.map(attempt => {
    const problems = attemptProblems(attempt, config);
    if (!attempt.campaignId) problems.push("missing-attempt-receipt");
    if (receipts.get(`${attempt.campaignId}:${attempt.result.executionId}:${attempt.result.attempt}`)! > 1)
      problems.push("duplicate-attempt-receipt");
    if ((attempt.result.issueId && issues.get(attempt.result.issueId)! > 1) || attempt.result.runIds?.some(id => runs.get(id)! > 1))
      problems.push("reused-task-or-run");
    return { campaignId: attempt.campaignId, executionId: attempt.result.executionId, attempt: attempt.result.attempt,
      cell: attempt.cell, phase: attempt.phase, startedAt: attempt.result.startedAt, finishedAt: attempt.result.finishedAt,
      originalStatus: attempt.result.status, qualified: problems.length === 0, problems };
  });
  const cells = DEPENDABLE_CELLS.map(cell => {
    const candidate = observations.filter(row => row.cell === cell && row.phase === "candidate" && row.qualified)
      .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    const checkpointAt = candidate.length >= 3 ? Date.parse(candidate[2]!.finishedAt) : null;
    const staging = observations.filter(row => row.cell === cell && row.phase === "staging" && row.qualified &&
      checkpointAt !== null && Date.parse(row.startedAt) > checkpointAt);
    return { cell, candidatePassed: candidate.length, candidateRequired: 3, stagingPassedAfterCheckpoint: staging.length,
      complete: checkpointAt !== null && staging.length > 0 };
  });
  return { schema: "paperclip.e2e.dependable-qualification.v1", revision: config.revision,
    requiredCells: 24, requiredCandidatePasses: 72, complete: cells.every(cell => cell.complete) && !observations.some(row =>
      row.problems.includes("duplicate-attempt-receipt") || row.problems.includes("missing-attempt-receipt")), cells,
    observations, failedAttempts: observations.filter(row => row.originalStatus === "failed").length,
    incompleteAttempts: observations.filter(row => !row.qualified).length };
}

export function dependableDailySelection(utcDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDate) || new Date(utcDate).toISOString().slice(0, 10) !== utcDate)
    throw new Error("Daily rotation requires an exact UTC date");
  const day = Math.floor(Date.parse(utcDate) / 86_400_000);
  const length = DEPENDABLE_JOURNEYS.length;
  const journey = DEPENDABLE_JOURNEYS[((day % length) + length) % length]!;
  return DEPENDABLE_CELLS.filter(cell => cell.endsWith(`.${journey}`));
}

export function dependableDailyExecutions(utcDate: string, availableIds: readonly string[]) {
  const ids = dependableDailySelection(utcDate).map(dependableExecutionId);
  const absent = DEPENDABLE_CELLS.map(dependableExecutionId).filter(id => !availableIds.includes(id));
  if (absent.length) throw new Error(`Dependable journeys not registered: ${absent.join(", ")}`);
  return ids;
}

export function gradeRetainedDependableResults(config: DependableQualification, entries: readonly {
  result: RunnerE2EResult;
  evidence: { files?: string[]; leaks?: unknown[]; missing?: unknown[] } | null;
  errors: readonly string[];
}[]) {
  const attempts = entries.flatMap(entry => {
    const receipt = entry.result.dependableWork;
    if (!receipt) return [];
    return [{ ...receipt, result: entry.result, evidence: { ...receipt.evidence,
      manifestVerified: entry.evidence !== null && entry.errors.length === 0,
      secretScanPassed: entry.evidence !== null && entry.evidence.leaks?.length === 0 } }];
  });
  const report = gradeDependableQualification(config, attempts);
  const unclassifiedResults = entries.filter(entry =>
    entry.result.suiteId === "dependable-work" && !entry.result.dependableWork).map(entry => ({
      executionId: entry.result.executionId, attempt: entry.result.attempt, originalStatus: entry.result.status,
      problem: "missing-observer-receipt" }));
  return { ...report, complete: report.complete && unclassifiedResults.length === 0, unclassifiedResults };
}
