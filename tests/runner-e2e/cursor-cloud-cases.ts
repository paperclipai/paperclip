import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";

export const CURSOR_CLOUD_SUITE = "cursor-cloud";
export const CURSOR_CLOUD_QUIET_WINDOW_MS = 15_000;
export function cursorCloudDefinitionDigest() {
  const hash = createHash("sha256");
  for (const file of ["catalog.ts", "cursor-cloud-cases.ts", "cursor-cloud-observer.ts", "cursor-cloud-stop-flow.ts", "cursor-cloud-stop-observation.ts", "cursor-cloud-callback-proxy.ts", "prerequisites.ts", "cursor-cloud-budget.ts", "live-fixtures.ts", "runner.spec.ts", "registered-artifact.ts"]) hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}
export const cursorCloudArtifactName = (nonce: string) => `cursor-cloud-${nonce}.txt`;
export const cursorCloudStopArtifactName = (nonce: string) => `cursor-cloud-after-stop-${nonce}.txt`;

export const cursorCloudArtifactTask: RunnerTaskFixture = {
  id: "task-artifact", label: "Complete a task with a verified Cloud artifact", groups: [],
  workMode: "standard", flow: "single_turn", expectedRunCount: 1, automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 600_000, daytona: 600_000 }, turnTimeoutMs: 480_000,
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Cursor Cloud artifact ${nonce}`,
  buildVisibleMarker: nonce => `CURSOR-CLOUD-DONE-${nonce}`,
  buildPrompt: nonce => [
    `Create exactly one file named ${cursorCloudArtifactName(nonce)} in this Cursor Cloud environment's provider-supported artifact output directory containing exactly ${JSON.stringify(`verified-${nonce}\n`)} as UTF-8 bytes. Use the environment's documented output directory; do not assume a legacy absolute path.`,
    "Verify the actual bytes with a read-only command; use one real LF byte at the end.",
    `Call list_cursor_cloud_artifacts to find the exact relative provider path for ${cursorCloudArtifactName(nonce)}. Use register_deliverable to register it under that exact filename title with contentRef cursor-artifact:<exact relative path returned by the helper>, mimeType text/plain, the actual byteSize and SHA-256 digest. Use the returned durable deliverable reference in your completion evidence.`,
    `Call paperclip_finish with reportedWorkDisposition done, summary CURSOR-CLOUD-DONE-${nonce}, the current completion contract revision, satisfied objective criterion, no remaining work, and actual validation evidence. Wait for acceptance, then emit exactly CURSOR-CLOUD-DONE-${nonce}.`,
    "Do not create PRs, other tasks, agents, or unrelated files.",
  ].join("\n"),
  buildMatchers: (nonce, execution) => [
    { kind: "message_exact", expected: `CURSOR-CLOUD-DONE-${nonce}` },
    { kind: "issue_status", expected: "done" }, { kind: "run_status", expected: "succeeded" },
    { kind: "runtime_mode", expected: "native" }, { kind: "environment", expected: execution.environment.id },
    { kind: "artifact_exact", name: cursorCloudArtifactName(nonce), expected: `verified-${nonce}\n`, mimeType: "text/plain" },
  ],
};

export const cursorCloudStopTask: RunnerTaskFixture = {
  id: "active-run-stop", label: "Stop an independently observed active Cloud run", groups: [],
  workMode: "standard", flow: "cursor_cloud_stop", expectedRunCount: 1, automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 480_000, daytona: 480_000 }, turnTimeoutMs: 360_000,
  expectedTerminalState: { issue: "in_progress", run: "cancelled" },
  buildTitle: nonce => `Cursor Cloud active Stop ${nonce}`,
  buildVisibleMarker: nonce => `CURSOR-CLOUD-STOP-${nonce}`,
  buildPrompt: nonce => [
    "Begin one native foreground shell command now. This acceptance fixture will be stopped by the operator while that command is active.",
    `Find the environment's documented artifact output directory using read-only tools. Then run this exact foreground shell command, replacing only /ABSOLUTE_OUTPUT_DIRECTORY with that directory: sleep 180 && printf 'MUST_NOT_APPEAR\\n' > '/ABSOLUTE_OUTPUT_DIRECTORY/${cursorCloudStopArtifactName(nonce)}'. Do not add a wrapper, background operator, extra command, or change the quoted output bytes.`,
    "Keep the command in the foreground. Do not background it, finish the task, retry after cancellation, register a deliverable, or create any other work. The operator's Stop is authoritative.",
  ].join("\n"),
  buildMatchers: () => [],
};
