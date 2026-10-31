import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

const failures = new Map([
  ["Credential-contaminated original evidence cannot be retained", "credential-contamination"],
  ["Unsupported original evidence carrier cannot be retained", "unsupported-carrier"],
  ["Complete original evidence exceeds byte allowance", "byte-bound"],
  ["Complete original evidence exceeds entry allowance", "entry-bound"],
]);
const phases = [
  ["Real prior active Launch checkout", "held-work-timeout"],
  ["Canonical project-defaults turn settles", "canonical-turn-timeout"],
  ["Actual new native task reads inherited project context", "future-work-timeout"],
];
const member = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value) ? value : "unknown";
export function privateAttemptDiagnostic(input: { stage: unknown; result?: { status?: unknown; failureClass?: unknown; error?: unknown; runIds?: unknown; matcherResults?: unknown }; error?: unknown }) {
  const message = input.error instanceof Error ? input.error.message : "";
  const productError = typeof input.result?.error === "string" ? input.result.error : "";
  return {
    schema: "paperclip.private-attempt-diagnostic/v1",
    stage: member(input.stage, ["execution", "package-original", "seal-original"]),
    status: member(input.result?.status, ["passed", "failed", "skipped"]),
    failureClass: member(input.result?.failureClass, ["candidate_failure", "transient_infrastructure", "permanent_infrastructure", "secret_leak", "cleanup_failure"]),
    finalization: failures.get(message) ?? "unclassified",
    phase: phases.find(([label]) => productError.includes(label!) || message.includes(label!))?.[1] ?? "unclassified",
    runs: Array.isArray(input.result?.runIds) ? Math.min(input.result.runIds.length, 1000) : 0,
    checks: Array.isArray(input.result?.matcherResults) ? Math.min(input.result.matcherResults.length, 1000) : 0,
  };
}

/** Fixed codes and counts only. Raw evidence still requires its unchanged protected transfer. */
export async function appendPrivateAttemptDiagnostic(input: Parameters<typeof privateAttemptDiagnostic>[0], env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || !env.GITHUB_STEP_SUMMARY || !env.RUNNER_TEMP) return;
  const root = await realpath(env.RUNNER_TEMP), parent = await realpath(path.dirname(env.GITHUB_STEP_SUMMARY));
  if (!parent.startsWith(`${root}${path.sep}`)) throw new Error("Diagnostic summary escaped runner temporary directory");
  const file = await open(env.GITHUB_STEP_SUMMARY, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("Invalid diagnostic summary owner");
    await file.write(`\nPrivate attempt diagnostic (codes and counts only):\n\n\`\`\`json\n${JSON.stringify(privateAttemptDiagnostic(input))}\n\`\`\`\n`);
  } finally { await file.close(); }
}
