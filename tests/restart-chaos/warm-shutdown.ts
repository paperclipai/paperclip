export interface WarmShutdownCleanup {
  environmentDeleted: boolean;
  environmentDeleteBlocked: string | null;
  remainingSandboxes: string[];
  undeletedSandboxes?: string[];
}

export interface WarmCloseFailure {
  runId: string | null;
  reason: string;
  lines: number;
  firstLine: string;
}

export interface WarmShutdownCheck {
  verdict: "pass" | "fail";
  environmentDeleted: boolean | null;
  environmentDeleteBlocked: string | null;
  leakedSandboxes: string[];
  shutdownCloseFailures: WarmCloseFailure[];
  idleCloseFailures: WarmCloseFailure[];
  sandboxCaptures: string[];
  problems: string[];
}

const SHUTDOWN_CLOSE_FAILURE = /idle native session cleanup failed before controller shutdown|idle warm native sessions did not close.*"reason":"(environment deleted|controller restart)"/;
const IDLE_CLOSE_FAILURE = /idle warm native session (close|detach) failed|warm native session close did not settle|warm native session's sandbox was already destroyed/;
const FIRST_IDLE_CLOSE_FAILURE = /idle warm native session (close|detach) failed|idle warm native sessions did not close|idle native session cleanup failed before controller shutdown/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const MAX_PARTIAL_LINE = 256 * 1024;

export function controllerLogNames(names: readonly string[]): string[] {
  return names.filter(name => /^server(-[a-z0-9]+)?\.log$/.test(name)).sort();
}

export function isWarmWave(options: { lifecycle?: string; daytonaWarm?: boolean }): boolean {
  return options.lifecycle === "warm" || options.daytonaWarm === true;
}

function cleanLine(line: string): string {
  return line.replace(ANSI, "").trim();
}

function lineDetail(line: string): Record<string, unknown> | null {
  const start = line.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(start)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function lineMessage(line: string): string {
  const brace = line.indexOf("{");
  return (brace < 0 ? line : line.slice(0, brace)).replace(/^\[[^\]]*\]\s*/, "").trim();
}

function failureReason(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.split(" {")[0]!.trim();
}

function lineFailures(line: string): Array<{ runId: string | null; reason: string }> {
  const detail = lineDetail(line);
  const listed = Array.isArray(detail?.failures) ? detail.failures
    : Array.isArray((detail?.idleSessions as Record<string, unknown> | undefined)?.failures)
      ? (detail!.idleSessions as Record<string, unknown>).failures as unknown[] : null;
  const fromList = (listed ?? []).flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const reason = failureReason(item.reason) ?? failureReason(item.closeFailure);
    return [{ runId: typeof item.runId === "string" ? item.runId : null, reason: reason ?? lineMessage(line) }];
  });
  if (fromList.length) return fromList;
  if (detail && typeof detail.runId === "string") {
    return [{ runId: detail.runId, reason: failureReason(detail.closeFailure) ?? lineMessage(line) }];
  }
  const body = line.replace(/^\[[^\]]*\]\s*/, "");
  return [{ runId: null, reason: body }];
}

export function distinctCloseFailures(lines: readonly string[]): WarmCloseFailure[] {
  const byKey = new Map<string, WarmCloseFailure>();
  for (const line of lines) {
    for (const failure of lineFailures(line)) {
      const key = `${failure.runId ?? ""}\u0000${failure.reason}`;
      const existing = byKey.get(key);
      if (existing) existing.lines += 1;
      else byKey.set(key, { runId: failure.runId, reason: failure.reason, lines: 1, firstLine: line });
    }
  }
  return [...byKey.values()];
}

export function gradeWarmShutdown(input: { cleanup: WarmShutdownCleanup | null; serverLog: string; sandboxCaptures?: readonly string[] }): WarmShutdownCheck {
  const lines = input.serverLog.split("\n").map(cleanLine).filter(Boolean);
  const shutdownCloseFailures = distinctCloseFailures(lines.filter(line => SHUTDOWN_CLOSE_FAILURE.test(line)));
  const idleCloseFailures = distinctCloseFailures(lines.filter(line => IDLE_CLOSE_FAILURE.test(line)));
  const problems: string[] = [];
  if (input.cleanup?.environmentDeleteBlocked) problems.push(`environment delete blocked: ${input.cleanup.environmentDeleteBlocked}`);
  else if (input.cleanup && !input.cleanup.environmentDeleted) problems.push("environment was not deleted");
  if (input.cleanup?.remainingSandboxes.length) problems.push(`sandboxes still running after cleanup: ${input.cleanup.remainingSandboxes.join(", ")}`);
  if (input.cleanup?.undeletedSandboxes?.length) problems.push(`wave sandboxes left after the harness deleted them: ${input.cleanup.undeletedSandboxes.join(", ")}`);
  for (const failure of shutdownCloseFailures) {
    problems.push(`warm session did not close: run ${failure.runId ?? "unknown"} (${failure.lines} log line${failure.lines === 1 ? "" : "s"}): ${failure.reason}`);
  }
  return {
    verdict: problems.length ? "fail" : "pass",
    environmentDeleted: input.cleanup?.environmentDeleted ?? null,
    environmentDeleteBlocked: input.cleanup?.environmentDeleteBlocked ?? null,
    leakedSandboxes: [...new Set([...input.cleanup?.remainingSandboxes ?? [], ...input.cleanup?.undeletedSandboxes ?? []])],
    shutdownCloseFailures,
    idleCloseFailures,
    sandboxCaptures: [...input.sandboxCaptures ?? []],
    problems,
  };
}

export function watchFirstIdleCloseFailure(onFailure: (failure: { runId: string | null; line: string }) => void): (chunk: Buffer | string, source?: string) => void {
  const partials = new Map<string, string>();
  let fired = false;
  return (chunk, source = "") => {
    if (fired) return;
    const lines = `${partials.get(source) ?? ""}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`.split("\n");
    const rest = lines.pop() ?? "";
    partials.set(source, rest.length > MAX_PARTIAL_LINE ? "" : rest);
    for (const raw of lines) {
      const line = cleanLine(raw);
      if (!FIRST_IDLE_CLOSE_FAILURE.test(line)) continue;
      fired = true;
      onFailure({ runId: lineFailures(line)[0]?.runId ?? null, line });
      return;
    }
  };
}

export async function waitBounded(pending: () => Promise<unknown> | null, ms: number): Promise<"settled" | "timed_out" | "none"> {
  const work = pending();
  if (!work) return "none";
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([work.then(() => "settled" as const, () => "settled" as const),
    new Promise<"timed_out">(resolve => { timer = setTimeout(() => resolve("timed_out"), ms); })]);
  clearTimeout(timer);
  return outcome;
}

export function warmShutdownMarkdown(check: WarmShutdownCheck): string {
  const out = ["## Clean warm shutdown (no leaked sandboxes)", "",
    `Verdict: ${check.verdict.toUpperCase()}. Environment deleted: ${check.environmentDeleted ?? "n/a"}; sandboxes left running: ${check.leakedSandboxes.length}; `
      + `warm sessions that did not close: ${check.shutdownCloseFailures.length}; idle closes that needed a forced stop or failed: ${check.idleCloseFailures.length}.`, ""];
  for (const problem of check.problems) out.push(`- ${problem.slice(0, 2_000)}`);
  if (check.problems.length) out.push("");
  if (check.sandboxCaptures.length) out.push(`Sandbox captures at the first idle-close failure: ${check.sandboxCaptures.join(", ")} (daytona-runner/).`, "");
  return out.join("\n");
}
