export interface WarmShutdownCleanup {
  environmentDeleted: boolean;
  environmentDeleteBlocked: string | null;
  remainingSandboxes: string[];
  undeletedSandboxes?: string[];
}

export interface WarmShutdownCheck {
  verdict: "pass" | "fail";
  environmentDeleted: boolean | null;
  environmentDeleteBlocked: string | null;
  leakedSandboxes: string[];
  shutdownCloseFailures: string[];
  idleCloseFailures: string[];
  problems: string[];
}

const SHUTDOWN_CLOSE_FAILURE = /idle native session cleanup failed before controller shutdown|idle warm native sessions did not close.*"reason":"(environment deleted|controller restart)"/;
const IDLE_CLOSE_FAILURE = /idle warm native session (close|detach) failed|warm native session close did not settle|warm native session's sandbox was already destroyed/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function controllerLogNames(names: readonly string[]): string[] {
  return names.filter(name => /^server(-[a-z0-9]+)?\.log$/.test(name)).sort();
}

export function isWarmWave(options: { lifecycle?: string; daytonaWarm?: boolean }): boolean {
  return options.lifecycle === "warm" || options.daytonaWarm === true;
}

export function gradeWarmShutdown(input: { cleanup: WarmShutdownCleanup | null; serverLog: string }): WarmShutdownCheck {
  const lines = input.serverLog.split("\n").map(line => line.replace(ANSI, "").trim()).filter(Boolean);
  const shutdownCloseFailures = lines.filter(line => SHUTDOWN_CLOSE_FAILURE.test(line));
  const idleCloseFailures = lines.filter(line => IDLE_CLOSE_FAILURE.test(line));
  const problems: string[] = [];
  if (input.cleanup?.environmentDeleteBlocked) problems.push(`environment delete blocked: ${input.cleanup.environmentDeleteBlocked}`);
  else if (input.cleanup && !input.cleanup.environmentDeleted) problems.push("environment was not deleted");
  if (input.cleanup?.remainingSandboxes.length) problems.push(`sandboxes still running after cleanup: ${input.cleanup.remainingSandboxes.join(", ")}`);
  if (input.cleanup?.undeletedSandboxes?.length) problems.push(`wave sandboxes left after the harness deleted them: ${input.cleanup.undeletedSandboxes.join(", ")}`);
  for (const line of shutdownCloseFailures) problems.push(`warm session did not close: ${line}`);
  return {
    verdict: problems.length ? "fail" : "pass",
    environmentDeleted: input.cleanup?.environmentDeleted ?? null,
    environmentDeleteBlocked: input.cleanup?.environmentDeleteBlocked ?? null,
    leakedSandboxes: [...new Set([...input.cleanup?.remainingSandboxes ?? [], ...input.cleanup?.undeletedSandboxes ?? []])],
    shutdownCloseFailures,
    idleCloseFailures,
    problems,
  };
}

export function warmShutdownMarkdown(check: WarmShutdownCheck): string {
  const out = ["## Clean warm shutdown (no leaked sandboxes)", "",
    `Verdict: ${check.verdict.toUpperCase()}. Environment deleted: ${check.environmentDeleted ?? "n/a"}; sandboxes left running: ${check.leakedSandboxes.length}; `
      + `warm sessions that did not close: ${check.shutdownCloseFailures.length}; idle closes that needed a forced stop or failed: ${check.idleCloseFailures.length}.`, ""];
  for (const problem of check.problems) out.push(`- ${problem.slice(0, 2_000)}`);
  if (check.problems.length) out.push("");
  return out.join("\n");
}
