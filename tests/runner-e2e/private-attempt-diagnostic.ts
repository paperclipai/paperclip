import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export interface PrivateAttemptDiagnosticInput { stage: unknown; result?: unknown; error?: unknown; observation?: unknown; evidence?: unknown }
const record = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
const member = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value) ? value : "unknown";
const failures = new Map([
  ["Credential-contaminated original evidence cannot be retained", "credential-contamination"],
  ["Unsupported original evidence carrier cannot be retained", "unsupported-carrier"],
  ["Complete original evidence exceeds byte allowance", "byte-bound"],
  ["Complete original evidence exceeds entry allowance", "entry-bound"],
]);
const phases = [["Real prior active Launch checkout", "held-work-timeout"], ["Canonical project-defaults turn settles", "canonical-turn-timeout"], ["Actual new native task reads inherited project context", "future-work-timeout"]];
/** Closed labels/counts only; never copy an error, identity, path, body or provider value. */
export function privateAttemptDiagnostic(input: PrivateAttemptDiagnosticInput) {
  const result = record(input.result), envelope = record(input.observation), observation = record(envelope.observation), state = record(observation.state);
  const runs = Array.isArray(observation.runs) ? observation.runs.map(record) : [];
  const status = (run: Record<string, any> | undefined) => member(run?.status, ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]);
  const message = input.error instanceof Error ? input.error.message : "", productError = typeof result.error === "string" ? result.error : "";
  const evidence = record(input.evidence), leaks = Array.isArray(evidence.leaks) ? evidence.leaks : [];
  return {
    schema: "paperclip.private-attempt-diagnostic/v1",
    stage: member(input.stage, ["execution", "package-original", "seal-original"]),
    status: member(result.status, ["passed", "failed", "skipped"]),
    failureClass: member(result.failureClass, ["candidate_failure", "transient_infrastructure", "permanent_infrastructure", "secret_leak", "cleanup_failure"]),
    finalization: failures.get(message) ?? "unclassified",
    phase: phases.find(([label]) => productError.includes(label!) || message.includes(label!))?.[1] ?? "unclassified",
    runStatusCounts: Object.fromEntries(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"].map(label =>
      [label, Math.min(runs.filter(run => run.status === label).length, 1000)])),
    runs: Math.min(runs.length || (Array.isArray(result.runIds) ? result.runIds.length : 0), 1000),
    checks: Array.isArray(result.matcherResults) ? Math.min(result.matcherResults.length, 1000) : 0,
    source: status(runs.find(run => typeof observation.leadId === "string" && run.agentId === observation.leadId)),
    future: status(runs.find(run => typeof record(state.futureWorker).id === "string" && run.agentId === record(state.futureWorker).id)),
    held: status(runs.find(run => typeof state.activeRunId === "string" && run.id === state.activeRunId)),
    productGradePassed: record(envelope.grade).passed === true,
    carrier: leaks.some(leak => record(leak).reason === "zip inspection exceeded its expanded-byte bound") ? "zip-byte-bound"
      : leaks.some(leak => record(leak).reason === "zip inspection exceeded its time bound") ? "zip-time-bound" : leaks.length ? "other-finding" : "none",
  };
}
export async function readPrivateAttemptObservation(casePrivateDir: string) {
  try {
    const file = path.join(casePrivateDir, "snapshots/chat-catalog-observation.json"), metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8 * 1024 * 1024) return;
    return JSON.parse(await readFile(file, "utf8"));
  } catch { return; }
}
/**
 * GITHUB_ENV survives the paid step's private stdout redirect. SetEnvFileCommand
 * updates the env context; ActionRunner passes it to ScriptHandler, whose
 * PrintActionDetails prints it before the next trusted shell step runs.
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/ScriptHandler.cs#L120-L126
 * The variable is not consumed as authority by the protected transfer.
 */
export async function appendPrivateAttemptDiagnostic(input: PrivateAttemptDiagnosticInput, env = process.env) {
  if (env.GITHUB_ACTIONS !== "true") return;
  if (!env.GITHUB_ENV || !env.RUNNER_TEMP) throw new Error("Closed private diagnostic channel is unavailable");
  const root = await realpath(env.RUNNER_TEMP), parent = await realpath(path.dirname(env.GITHUB_ENV));
  if (!parent.startsWith(`${root}${path.sep}`) || !path.basename(env.GITHUB_ENV).startsWith("set_env_")) throw new Error("Diagnostic environment file escaped runner commands");
  const file = await open(env.GITHUB_ENV, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("Invalid diagnostic environment file owner");
    await file.write(`PAPERCLIP_E2E_CLOSED_DIAGNOSTIC_V1=${JSON.stringify(privateAttemptDiagnostic(input))}\n`);
  } finally { await file.close(); }
}
