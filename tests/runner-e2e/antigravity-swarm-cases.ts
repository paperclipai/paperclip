import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EnvironmentFixture, RunnerProfileFixture, RunnerSuiteFixture, RunnerTaskFixture } from "./types.js";

/**
 * Google Antigravity native `/swarm` (Antigravity CLI route). Attended and
 * explicit-only: it needs the instance flag "Google Antigravity swarm", the
 * pinned CLI installed with `paperclipai runtime setup antigravity-cli`, and
 * the Antigravity CLI signed in to Google on this computer. These cells are
 * listed and selectable but never run in CI; until an automated executor is
 * built, the launcher refuses them and points at the live recipe in
 * doc/plans/2026-11-22-antigravity-qualification.md ("/swarm live proof").
 */
export const ANTIGRAVITY_SWARM_SUITE = "antigravity-swarm";
export const ANTIGRAVITY_SWARM_MODEL = "gemini-3.8-flash-low";
export const ANTIGRAVITY_SWARM_CASES = [
  "two-helpers-and-verifier", "stop-mid-swarm", "process-loss-retry", "follow-up-after-swarm", "flag-off-refusal",
] as const;
export const ANTIGRAVITY_SWARM_RECIPE = "doc/plans/2026-11-22-antigravity-qualification.md#swarm-live-proof";

const LABELS: Record<(typeof ANTIGRAVITY_SWARM_CASES)[number], { label: string; runs: number; issue: RunnerTaskFixture["expectedTerminalState"]["issue"]; run: "succeeded" | "cancelled" | "failed" }> = {
  "two-helpers-and-verifier": { label: "Two helpers write a.txt and b.txt, a verifier checks both; task Done", runs: 1, issue: "done", run: "succeeded" },
  "stop-mid-swarm": { label: "Stop mid-swarm stops every helper and leaves no process", runs: 1, issue: "in_progress", run: "cancelled" },
  "process-loss-retry": { label: "Kill the CLI mid-swarm, Retry starts a fresh swarm in the same task folder", runs: 2, issue: "done", run: "succeeded" },
  "follow-up-after-swarm": { label: "An ordinary follow-up after a swarm runs on the registry route", runs: 2, issue: "done", run: "succeeded" },
  "flag-off-refusal": { label: "With the flag off, /swarm gets the plain 'not available' message and nothing runs", runs: 0, issue: "in_progress", run: "succeeded" },
};

export function buildAntigravitySwarmSuite(environments: readonly EnvironmentFixture[]): RunnerSuiteFixture {
  const profile: RunnerProfileFixture = { id: "runner-antigravity-swarm", label: "Google Antigravity swarm (CLI route)", generation: "native", groups: [],
    adapterType: "paperclip_runner", provider: "acpx", model: ANTIGRAVITY_SWARM_MODEL, credential: "GEMINI_API_KEY",
    supportedEnvironments: ["local"], expectedRuntimeMode: "native", expectedRuntimeMetadata: { adapterType: "paperclip_runner", provider: "acpx" },
    modelQualification: { source: "candidate_runner_profile", qualificationId: "antigravity:operator-admitted-darwin-arm64-cli-swarm" },
    buildAgent: () => { throw new Error("The swarm cells use an Antigravity agent created through the ordinary UI"); } };
  const hash = createHash("sha256");
  for (const file of ["antigravity-swarm-cases.ts", "../../packages/paperclip-runner/antigravity-cli-distributions.json"]) {
    hash.update(file).update(readFileSync(new URL(`./${file}`, import.meta.url)));
  }
  const tasks: RunnerTaskFixture[] = ANTIGRAVITY_SWARM_CASES.map(id => ({
    id, label: LABELS[id].label, groups: [], flow: "antigravity_swarm_journey", workMode: "standard",
    expectedRunCount: LABELS[id].runs, minimumExpectedRunCount: LABELS[id].runs, automaticRetryPolicy: "single_attempt",
    attemptTimeoutMs: { local: 1_800_000, daytona: 1_800_000 }, turnTimeoutMs: 1_200_000,
    expectedTerminalState: { issue: LABELS[id].issue, run: LABELS[id].run },
    buildTitle: nonce => `Antigravity swarm ${nonce}`,
    buildPrompt: () => "/swarm two helpers: one writes a.txt containing A, one writes b.txt containing B; a verifier checks both",
    buildVisibleMarker: nonce => nonce, buildMatchers: () => [],
  }));
  return { id: ANTIGRAVITY_SWARM_SUITE, label: "Google Antigravity native swarm", groups: [], manualOnly: true,
    description: "Trusted /swarm from the task composer runs Antigravity's native swarm on the pinned CLI in the task folder: completion, Stop, process loss and Retry, follow-up, and the flag-off refusal.",
    profiles: [profile], environments: environments.filter(environment => environment.id === "local"), expectedMatrixSize: ANTIGRAVITY_SWARM_CASES.length,
    definitionMetadata: { version: 1, digest: hash.digest("hex"), scheduling: "explicit-only", route: "antigravity-cli",
      authentication: "existing-antigravity-cli-google-sign-in-on-this-computer", setup: "attached-self-hosted-local-darwin-arm64",
      requires: ["instance.experimental.enableAntigravitySwarm", "paperclipai runtime setup antigravity-cli"], recipe: ANTIGRAVITY_SWARM_RECIPE,
      executor: "attended-recipe-only", globalQualification: "pending", mcpConnections: [] },
    tasks };
}
