import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ANTIGRAVITY_JOURNEY_MODEL } from "./antigravity-journey-config.js";
import type { EnvironmentFixture, RunnerProfileFixture, RunnerSuiteFixture } from "./types.js";

export const ANTIGRAVITY_JOURNEY_SUITE = "antigravity-agent-journey";
export const ANTIGRAVITY_JOURNEY_CASE = "saved-subscription-two-turn";
export const ANTIGRAVITY_JOURNEY_EXECUTION = `${ANTIGRAVITY_JOURNEY_SUITE}.runner-antigravity.local.${ANTIGRAVITY_JOURNEY_CASE}`;

export function buildAntigravityJourneySuite(environments: readonly EnvironmentFixture[]): RunnerSuiteFixture {
  const profile: RunnerProfileFixture = { id: "runner-antigravity", label: "Google Antigravity candidate", generation: "native", groups: [],
    // The catalog's legacy required field is never resolved for this flow;
    // requiredCredentials is empty and the saved product connection is verified.
    adapterType: "paperclip_runner", provider: "acpx", model: ANTIGRAVITY_JOURNEY_MODEL, credential: "GEMINI_API_KEY",
    supportedEnvironments: ["local"], expectedRuntimeMode: "native", expectedRuntimeMetadata: { adapterType: "paperclip_runner", provider: "acpx" },
    modelQualification: { source: "candidate_runner_profile", qualificationId: "antigravity:operator-admitted-darwin-arm64-saved-subscription" },
    buildAgent: () => { throw new Error("The measured Antigravity agent must be created through the ordinary UI"); } };
  const hash = createHash("sha256");
  for (const file of ["antigravity-journey-cases.ts", "antigravity-journey-config.ts", "antigravity-journey-fixtures.ts", "antigravity-journey-flow.ts", "antigravity-journey-launch.ts", "antigravity-journey-evidence.ts", "antigravity-journey-report.ts", "antigravity-journey-ui.ts", "copilot-local-fixtures.ts", "user-actions.ts",
    "../../packages/paperclip-runner/src/drivers/acpx/generated-profiles.ts", "../../packages/paperclip-runner/antigravity-distributions.json"])
    hash.update(file).update(readFileSync(new URL(`./${file}`, import.meta.url)));
  return { id: ANTIGRAVITY_JOURNEY_SUITE, label: "Antigravity additional-agent setup and two-turn task", groups: [], manualOnly: true,
    description: "Ordinary agent picker, saved Google subscription, exact Low model, native setup test, instruction-only file proof and persisted follow-up.",
    profiles: [profile], environments: environments.filter(environment => environment.id === "local"), expectedMatrixSize: 1,
    definitionMetadata: { version: 1, digest: hash.digest("hex"), scheduling: "explicit-only", authentication: "existing-same-user-personal-default-google-subscription",
      setup: "attached-self-hosted-local-darwin-arm64", admission: "trusted-operator-candidate-startup-required", freshOAuth: false, globalQualification: "pending", mcpConnections: [],
      dependencies: [{ alias: "browser_operator", consumer: "browser" }, { alias: "product_agent", consumer: "product-agent", phase: "created-in-journey" }, { alias: "independent_observer", consumer: "harness" }] },
    tasks: [{ id: ANTIGRAVITY_JOURNEY_CASE, label: "Add an agent, reuse subscription, complete a task and follow-up", groups: [], flow: "antigravity_agent_journey", workMode: "standard",
      expectedRunCount: 2, minimumExpectedRunCount: 2, automaticRetryPolicy: "single_attempt", attemptTimeoutMs: { local: 1_800_000, daytona: 1_800_000 }, turnTimeoutMs: 300_000,
      expectedTerminalState: { issue: "done", run: "succeeded" }, buildTitle: nonce => `Antigravity file proof ${nonce}`, buildPrompt: () => "Runtime-generated instruction-only nonce file proof.", buildVisibleMarker: nonce => nonce, buildMatchers: () => [] }] };
}
