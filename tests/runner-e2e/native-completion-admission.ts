import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MatrixExecution } from "./types.js";

const root = path.resolve(import.meta.dirname, "../..");
export const NATIVE_COMPLETION_PREFLIGHT_ENV = "PAPERCLIP_RUNNER_E2E_NATIVE_COMPLETION_PREFLIGHT";

/** Explicit fixture policy is enforced even when the workflow supplies only --id. */
export function assertNativeCompletionSelection(executions: readonly MatrixExecution[]): void {
  const profiles = ["runner-codex", "runner-acpx-claude", "runner-opencode"];
  const tasks = ["assigned-skill-explicit-invocation", "native-blocked-report"];
  for (const execution of executions.filter(execution => execution.suite.id === "native-completion")) {
    const suite = execution.suite;
    if (!profiles.includes(execution.profile.id) || execution.profile.generation !== "native" ||
        execution.profile.qualificationCandidate !== undefined || execution.environment.id !== "local" ||
        !tasks.includes(execution.task.id) || execution.task.expectedRunCount !== 1 ||
        (execution.task.minimumExpectedRunCount !== undefined && execution.task.minimumExpectedRunCount !== 1) ||
        execution.task.automaticRetryPolicy !== "single_attempt" ||
        execution.id !== `native-completion.${execution.profile.id}.local.${execution.task.id}` ||
        suite.manualOnly !== true || suite.expectedMatrixSize !== 6 || suite.tasks.length !== 2 ||
        !tasks.every(id => suite.tasks.filter(task => task.id === id && task.expectedRunCount === 1 &&
          task.automaticRetryPolicy === "single_attempt").length === 1)) {
      throw new Error("Native completion requires the declared local native fixtures, one turn and one attempt before provider execution.");
    }
  }
}

/** Future credentials and ambient auth overrides stay outside prerequisite children. */
export function nativeCompletionPreflightEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries([
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "LANG", "LC_ALL",
    "CARGO_HOME", "RUSTUP_HOME", "CI", "GITHUB_ACTIONS",
    "PAPERCLIP_RUNNER_E2E_SOURCE_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
  ].flatMap(name => source[name] === undefined ? [] : [[name, source[name]]]));
}

export function verifyNativeCompletionPreflight(receiptPath: string | undefined) {
  if (!receiptPath) throw new Error("Native completion has no prerequisite receipt; use the live launcher.");
  const run = spawnSync(process.execPath, [path.join(root, "tests/runner-e2e/native-completion-checks.mjs"), `--verify=${receiptPath}`], {
    cwd: root, env: nativeCompletionPreflightEnvironment(process.env), encoding: "utf8", timeout: 90_000,
  });
  if (run.status !== 0) throw new Error(`Native completion prerequisite verification failed: ${run.stderr || run.error?.message || run.status}`);
  const receipt = JSON.parse(run.stdout) as Record<string, unknown>;
  const expectedSourceSha = process.env.PAPERCLIP_RUNNER_E2E_SOURCE_SHA?.trim();
  if (expectedSourceSha && receipt.sourceSha !== expectedSourceSha)
    throw new Error("Native completion prerequisite source SHA differs from the requested immutable source.");
  return receipt;
}

export function prepareNativeCompletionPreflight(campaignDirectory: string) {
  const output = path.join(campaignDirectory, "native-completion-prerequisites", randomUUID());
  const receipt = path.join(output, "preflight.json");
  const run = spawnSync(process.execPath, [path.join(root, "tests/runner-e2e/native-completion-checks.mjs"), `--output-dir=${output}`], {
    cwd: root, env: nativeCompletionPreflightEnvironment(process.env), stdio: "inherit", timeout: 35 * 60_000,
  });
  if (run.status !== 0) throw new Error(`Native completion prerequisites failed before provider execution. Retained receipt: ${receipt}`);
  verifyNativeCompletionPreflight(receipt);
  return receipt;
}
