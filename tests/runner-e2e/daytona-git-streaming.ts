import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RunnerTaskFixture } from "./types.js";
import type { RunnerApi } from "./api.js";

const exec = promisify(execFile);
export const GIT_STREAMING_FILE_COUNT = 60_000;
export const GIT_STREAMING_PARENT = [...Array.from({ length: 2 }, () => "nested-".repeat(30)), "storybook-output"].join("/");
export const gitStreamingFilename = (index: number) => `${"asset-".repeat(36)}${index}.js`;
const unusualNames = [" space ", "line\nbreak", "-option", "雪-💾", "wild[?]*"];

/** Seed an ordinary empty project repository before its first public task. */
export async function setupGitStreamingWorkspace(workspacePath: string): Promise<void> {
  await exec("git", ["init", "-q"], { cwd: workspacePath });
  await exec("git", ["-c", "user.name=Runner E2E", "-c", "user.email=runner-e2e@example.test", "commit", "--allow-empty", "-qm", "Empty E2E workspace"], { cwd: workspacePath });
}

export function createGitStreamingTask(base: RunnerTaskFixture): RunnerTaskFixture {
  const setup = [
    "python3 - <<'PY'",
    "from pathlib import Path",
    `parent = Path(${JSON.stringify(GIT_STREAMING_PARENT)})`,
    "parent.mkdir(parents=True, exist_ok=True)",
    `for index in range(${GIT_STREAMING_FILE_COUNT}):`,
    "    (parent / ('asset-' * 36 + str(index) + '.js')).write_text('base')",
    `for name in ${JSON.stringify(unusualNames)}:`,
    "    Path(name).write_text(name)",
    `print('generated', ${GIT_STREAMING_FILE_COUNT}, 'files')`,
    "PY",
  ].join("\n");
  const verify = (previousTurn: number, nextTurn: number) => [
    "Before continuing, run this command and confirm it succeeds:",
    "python3 - <<'PY'",
    "from pathlib import Path",
    `parent = Path(${JSON.stringify(GIT_STREAMING_PARENT)})`,
    `assert len(list(parent.iterdir())) == ${GIT_STREAMING_FILE_COUNT}`,
    `for index in range(${GIT_STREAMING_FILE_COUNT}):`,
    `    assert (parent / ('asset-' * 36 + str(index) + '.js')).read_text() == ${JSON.stringify(previousTurn === 1 ? "base" : `base-turn-${previousTurn}`)}`,
    `for name in ${JSON.stringify(unusualNames)}:`,
    "    assert Path(name).read_text() == name",
    `for index in range(${GIT_STREAMING_FILE_COUNT}):`,
    `    (parent / ('asset-' * 36 + str(index) + '.js')).write_text('base-turn-${nextTurn}')`,
    "print('all generated files preserved')",
    "PY",
    "Keep these generated files untracked. Do not rename, remove, add, commit, or ignore them.",
  ].join("\n");
  return {
    ...base,
    id: "large-path-three-turn",
    label: "Large Git filename manifest across three Daytona turns",
    // CI needs more than the ordinary warm fixture's ten minutes to prepare
    // and copy back 60,000 files (a measured continuation took eleven minutes).
    turnTimeoutMs: 15 * 60_000,
    // Reserve another five minutes for setup, host checks, and cleanup outside
    // the three per-turn deadlines.
    attemptTimeoutMs: { ...base.attemptTimeoutMs, daytona: 50 * 60_000 },
    buildTitle: nonce => `Runner E2E Git streaming ${nonce}`,
    buildPrompt: nonce => [
      "Execute this bounded fixture command once in the current execution workspace. It creates 60,000 small untracked files whose Git filename list exceeds 32 MiB. Keep all files untracked; do not add, commit, rename, delete, or ignore them. Do not print the filenames or file contents.",
      setup,
      base.buildPrompt(nonce),
    ].join("\n"),
    buildFollowupMessages: nonce => {
      const [second, third] = base.buildFollowupMessages!(nonce);
      return [`${verify(1, 2)}\n${second}`, `${verify(2, 3)}\n${third}`];
    },
  };
}

export function gradeGitStreamingInventory(names: string[]): { generatedFiles: number; filenameBytes: number } {
  const expected = new Set(Array.from({ length: GIT_STREAMING_FILE_COUNT }, (_, index) => gitStreamingFilename(index)));
  let filenameBytes = 0;
  for (const name of names) {
    if (!expected.delete(name)) throw new Error("Git copyback contains an unexpected or duplicate generated filename");
    filenameBytes += Buffer.byteLength(`${GIT_STREAMING_PARENT}/${name}`) + 1;
  }
  if (expected.size) throw new Error(`Git copyback is missing ${expected.size} generated files`);
  if (filenameBytes <= 32 * 1024 * 1024) throw new Error("Git filename fixture did not cross the 32 MiB boundary");
  return { generatedFiles: names.length, filenameBytes };
}

/** Read every copied-back file independently of the agent's verification. */
export async function gitStreamingEvidence(workspacePath: string, completedTurn: number) {
  if (![1, 2, 3].includes(completedTurn)) throw new Error("Git copyback requires an exact fixture turn");
  const expectedContents = completedTurn === 1 ? "base" : `base-turn-${completedTurn}`;
  const parent = path.join(workspacePath, GIT_STREAMING_PARENT);
  const names = await readdir(parent);
  const inventory = gradeGitStreamingInventory(names);
  for (let start = 0; start < names.length; start += 100) {
    await Promise.all(names.slice(start, start + 100).map(async name => {
      if (await readFile(path.join(parent, name), "utf8") !== expectedContents) throw new Error("Git copyback changed generated file contents or retained an earlier turn");
    }));
  }
  for (const name of unusualNames) {
    if (await readFile(path.join(workspacePath, name), "utf8") !== name) throw new Error("Git copyback changed an unusual filename or its contents");
  }
  return { ...inventory, verifiedContents: names.length, verifiedTurn: completedTurn, unusualNamesPreserved: unusualNames.length };
}

interface FinalizedRun {
  id: string;
  status: string;
  nativePhase?: string | null;
  resultJson?: { finalizationPhase?: string; workspaceFinalizeStatus?: string; nextAttemptAt?: string | null; failureCode?: string | null } | null;
  runnerProfileJson?: { nativeExecutionInput?: { session?: { lifecyclePolicy?: { mode?: string; idleTimeoutMs?: number | null } } } } | null;
}
interface WorkspaceOperation { heartbeatRunId: string | null; status: string }
interface RecoveryAction { status: string; wakePolicy?: { kind?: string } | null }
interface GitFinalizationObservation {
  runs: FinalizedRun[];
  operations: WorkspaceOperation[];
  recovery: { active: RecoveryAction | null; actions: RecoveryAction[] };
  scheduledRetry: unknown;
}

export function gradeGitFinalization(observation: GitFinalizationObservation) {
  const failures: string[] = [];
  if (observation.runs.length === 0) failures.push("No completed native run evidence");
  for (const run of observation.runs) {
    const policy = run.runnerProfileJson?.nativeExecutionInput?.session?.lifecyclePolicy;
    if (policy?.mode !== "warm" || policy.idleTimeoutMs !== 1_200_000) {
      failures.push(`Run ${run.id} did not admit the required 20-minute warm idle policy`);
    }
    if (run.status !== "succeeded" || run.nativePhase !== "committed" ||
      run.resultJson?.finalizationPhase !== "committed" || run.resultJson.workspaceFinalizeStatus !== "succeeded") {
      failures.push(`Run ${run.id} is not durably committed after workspace finalization`);
    }
    if (run.resultJson?.nextAttemptAt != null) failures.push(`Run ${run.id} still schedules a finalization retry`);
    if (run.resultJson?.failureCode != null) failures.push(`Run ${run.id} still projects an active finalization failure`);
    const operations = observation.operations.filter(operation => operation.heartbeatRunId === run.id);
    if (!operations.some(operation => operation.status === "succeeded")) failures.push(`Run ${run.id} has no successful workspace receipt`);
  }
  // The scoped endpoint also includes workspace cleanup with no run ID.
  if (observation.operations.some(operation => ["pending", "queued", "running"].includes(operation.status))) {
    failures.push("The workspace still has an active operation");
  }
  const actions = [observation.recovery.active, ...observation.recovery.actions].filter(action => action !== null);
  if (actions.some(action => ["active", "pending"].includes(action.status) && action.wakePolicy?.kind === "resume_native_run")) {
    failures.push("A recovery action still schedules a native run retry");
  }
  if (observation.scheduledRetry != null) failures.push("The task still has a scheduled retry");
  return { passed: failures.length === 0, failures };
}

/** Public durable receipts must agree before the next browser turn is sent. */
export async function gitFinalizationEvidence(api: RunnerApi, issueId: string, runIds: string[]) {
  const [runs, operationLists, recovery, issue] = await Promise.all([
    Promise.all(runIds.map(id => api.get<FinalizedRun>(`/api/heartbeat-runs/${id}`))),
    Promise.all(runIds.map(id => api.get<WorkspaceOperation[]>(`/api/heartbeat-runs/${id}/workspace-operations`))),
    api.get<GitFinalizationObservation["recovery"]>(`/api/issues/${issueId}/recovery-actions`),
    api.get<{ scheduledRetry?: unknown }>(`/api/issues/${issueId}`),
  ]);
  const observation: GitFinalizationObservation = { runs, operations: operationLists.flat(), recovery, scheduledRetry: issue.scheduledRetry };
  return { ...observation, ...gradeGitFinalization(observation) };
}
