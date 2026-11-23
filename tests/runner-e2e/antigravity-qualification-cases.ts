import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { ANTIGRAVITY_THINKING_LEVELS, antigravityFamilyModelIds } from "../../packages/shared/src/antigravity-models.js";
import { ANTIGRAVITY_GENERATED_MODEL_CATALOG } from "../../packages/shared/src/antigravity-models.generated.js";
import { nativePermissionDenialTasks } from "./native-active-stop-tasks.js";
import type { EnvironmentFixture, RunnerProfileFixture, RunnerSuiteFixture, RunnerTaskFixture } from "./types.js";

/** Unattended Google API-key route. The acceptance model is repeatable on a free-tier key. */
export const ANTIGRAVITY_PROFILE_ID = "runner-acpx-antigravity";
export const ANTIGRAVITY_ACCEPTANCE_MODEL = "gemini-3.8-flash-low";
export const ANTIGRAVITY_QUALIFICATION_SUITE = "antigravity-qualification";
export const ANTIGRAVITY_MODEL_LINEUP_SUITE = "antigravity-model-lineup";
export const ANTIGRAVITY_GEMINI4_LINEUP_SUITE = "antigravity-model-lineup-gemini4";
export const ANTIGRAVITY_MODEL_RECEIPT_CASE = "model-receipt";

/** Thinking level is part of the model ID: `<family>-<level>`. */
export { ANTIGRAVITY_THINKING_LEVELS };
/**
 * Lineups come from the catalog generated from the pinned runtime, never a
 * hand-kept list: the API-key lineup is exactly what a `gemini-api-key`
 * session lists, and each Gemini 4 family keeps its own levels. The server
 * marks the Gemini 4 families `agent_platform_only`; with an API key they are
 * selected through exact-model admission and need a billed Gemini API plan.
 */
const FAMILIES = ANTIGRAVITY_GENERATED_MODEL_CATALOG.families;
export const ANTIGRAVITY_API_KEY_FAMILIES = FAMILIES.filter(family => !family.agentPlatformOnly).map(family => family.id);
export const ANTIGRAVITY_GEMINI4_FAMILIES = FAMILIES.filter(family => family.agentPlatformOnly).map(family => family.id);

export function antigravityModelIds(families: readonly string[], levels?: readonly string[]): string[] {
  return families.flatMap(family => levels ? levels.map(level => `${family}-${level}`) : antigravityFamilyModelIds(family));
}
export const ANTIGRAVITY_API_KEY_LINEUP: readonly string[] = ANTIGRAVITY_GENERATED_MODEL_CATALOG.apiKey.models.map(model => model.id);
export const ANTIGRAVITY_GEMINI4_LINEUP: readonly string[] = antigravityModelIds(ANTIGRAVITY_GEMINI4_FAMILIES);

const MODEL_ID = /^gemini-[0-9][a-z0-9.-]*-(?:minimal|low|medium|high|extra_high)$/u;
/** Cell IDs split on dots, so the profile suffix replaces them. */
export function antigravityLineupProfileId(model: string): string {
  if (!MODEL_ID.test(model)) throw new Error(`Invalid Antigravity model ID: ${model}`);
  return `${ANTIGRAVITY_PROFILE_ID}-${model.replaceAll(".", "-").replaceAll("_", "-")}`;
}

/**
 * While the profile is pending, an unattended cell needs its own company-bound
 * candidate grant (server-restart-request.ts). When the profile flips to
 * qualified, that grant builder returns undefined and the same cells run as an
 * ordinary released profile: flipping needs no change here.
 */
export function antigravityQualificationStatus(): "pending" | "qualified" {
  return QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus === "pending" ? "pending" : "qualified";
}

/**
 * Exact-model receipt. The run's native input names the requested model; the
 * Runner's provider identity records the model the native connection
 * acknowledged. All three must equal the requested ID, not merely produce a reply.
 */
export function antigravityModelReceiptMatchers(model: string) {
  return [
    { kind: "json_path" as const, path: "run.runnerProfileJson.nativeExecutionInput.provider.agent", expected: "antigravity" },
    { kind: "json_path" as const, path: "run.runnerProfileJson.nativeExecutionInput.provider.model", expected: model },
    { kind: "json_path" as const, path: "run.runnerProfileJson.sessionCheckpoint.providerIdentity.requestedModel", expected: model },
    { kind: "json_path" as const, path: "run.runnerProfileJson.sessionCheckpoint.providerIdentity.effectiveModel", expected: model },
  ];
}

export interface AntigravitySuiteDependencies {
  nativeProfile(input: {
    id: string; label: string; provider: "acpx"; acpxAgent: "antigravity"; qualificationCandidate: "antigravity";
    model: string; credential: "GEMINI_API_KEY"; supportedEnvironments?: readonly ("local" | "daytona")[];
    modelQualification: RunnerProfileFixture["modelQualification"];
  }): RunnerProfileFixture;
  localEnvironment: EnvironmentFixture;
  daytonaEnvironment: EnvironmentFixture;
  daytonaWarmEnvironment: EnvironmentFixture;
  runnerTasks: readonly RunnerTaskFixture[];
  localIntegrityTasks: readonly RunnerTaskFixture[];
  extendedHarnessFileTask: RunnerTaskFixture;
  warmFollowupTask: RunnerTaskFixture;
  chatHardeningTasks: readonly RunnerTaskFixture[];
  nativeActiveStopTasks: readonly RunnerTaskFixture[];
  nativeProviderLossTasks: readonly RunnerTaskFixture[];
}

export function buildAntigravityProfile(deps: Pick<AntigravitySuiteDependencies, "nativeProfile">, model = ANTIGRAVITY_ACCEPTANCE_MODEL, id = ANTIGRAVITY_PROFILE_ID): RunnerProfileFixture {
  return deps.nativeProfile({
    id, label: model === ANTIGRAVITY_ACCEPTANCE_MODEL && id === ANTIGRAVITY_PROFILE_ID ? "Runner Google Antigravity (API key)" : `Runner Google Antigravity ${model}`,
    provider: "acpx", acpxAgent: "antigravity", qualificationCandidate: "antigravity",
    credential: "GEMINI_API_KEY", model,
    modelQualification: { source: "candidate_runner_profile", qualificationId: `antigravity:${QUALIFIED_ACPX_PROFILES.antigravity.agentServerVersion}:gemini-api-key:${model}` },
  });
}

/** Lifecycle cases that need one owned process tree per run use per-turn Daytona leases. */
const LIFECYCLE_CASES = ["pending-permission-stop", "permission-deny-stop", "pending-permission-provider-loss"] as const;

function definitionDigest(extra: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(extra));
  for (const file of ["antigravity-qualification-cases.ts", "native-active-stop-evidence.ts", "native-active-stop-flow.ts", "native-provider-loss-flow.ts", "native-active-stop-tasks.ts"])
    hash.update(file).update(readFileSync(new URL(`./${file}`, import.meta.url)));
  return hash.digest("hex");
}

/**
 * Mirrors kimi-qualification: ordinary daily work, files, questions, plans,
 * warm follow-ups and chat Stop/restart, plus the shared Cursor/Copilot
 * pending-permission Stop and provider-loss fixtures. SUITES.md maps each case
 * to its playbook section 13 row.
 */
export function buildAntigravityQualificationSuite(deps: AntigravitySuiteDependencies): RunnerSuiteFixture {
  const tasks = [
    ...deps.runnerTasks, ...deps.localIntegrityTasks, deps.extendedHarnessFileTask, deps.warmFollowupTask,
    ...deps.chatHardeningTasks.filter(task => ["stop-new-resume", "continuity-restart"].includes(task.id)),
    ...deps.nativeActiveStopTasks.filter(task => task.id === "pending-permission-stop"),
    ...nativePermissionDenialTasks,
    ...deps.nativeProviderLossTasks,
  ].map(task => ({ ...task, automaticRetryPolicy: "single_attempt" as const }));
  if (tasks.filter(task => (LIFECYCLE_CASES as readonly string[]).includes(task.id)).length !== LIFECYCLE_CASES.length) {
    throw new Error("Antigravity lifecycle fixtures are missing");
  }
  return {
    id: ANTIGRAVITY_QUALIFICATION_SUITE, label: "Google Antigravity Qualification", manualOnly: true,
    description: "Google Antigravity with a Gemini API key: replies, plans, questions, verified file delivery, warm follow-ups, Stop, controller restart, pending-permission Stop and provider loss through local and Daytona user journeys.",
    groups: ["native"],
    profiles: [buildAntigravityProfile(deps)],
    environments: [deps.localEnvironment, deps.daytonaWarmEnvironment],
    environmentOverrides: Object.fromEntries(LIFECYCLE_CASES.map(id => [id, { daytona: deps.daytonaEnvironment }])),
    tasks, expectedMatrixSize: tasks.length * 2,
    definitionMetadata: { version: 2, digest: definitionDigest(tasks.map(task => task.id)), runtime: QUALIFIED_ACPX_PROFILES.antigravity.agentServerVersion,
      model: ANTIGRAVITY_ACCEPTANCE_MODEL, authentication: "gemini-api-key", qualification: antigravityQualificationStatus(),
      candidateAdmission: "company-bound-grant-staged-at-company-creation-while-pending-none-once-qualified-v1",
      profileVersion: QUALIFIED_ACPX_PROFILES.antigravity.agentProfileVersion,
      scheduling: "explicit-only", maximumAttemptsPerCell: 1, repetitionsRequired: 1,
      permissionDenial: "browser-deny-then-stop-canonical-v1", nativeQuestions: "not-claimed", accounting: "usage-and-cost-unavailable",
      lifecycleEvidence: "canonical-runtime-request-and-tool-execution-without-provider-notices-v1",
      artifactOracle: "independent-workspace-and-public-download-bytes", stopBoundary: "provider-turn-started" },
  };
}

/**
 * One admission plus one prompt per exact model ID. The list is a parameter:
 * the registered suites use the API-key catalog and the Gemini 4 families, and
 * a caller can build another lineup for a different credential route.
 */
export function buildAntigravityModelLineupSuite(deps: Pick<AntigravitySuiteDependencies, "nativeProfile" | "localEnvironment" | "runnerTasks">, input: {
  id: string; label: string; models: readonly string[]; route: string;
}): RunnerSuiteFixture {
  if (!input.models.length || new Set(input.models).size !== input.models.length) throw new Error("Antigravity model lineup requires distinct models");
  const base = deps.runnerTasks.find(task => task.id === "message-marker");
  if (!base) throw new Error("Antigravity model lineup requires the ordinary reply fixture");
  const task: RunnerTaskFixture = { ...base, id: ANTIGRAVITY_MODEL_RECEIPT_CASE, label: "Admit the exact model and answer one prompt",
    automaticRetryPolicy: "single_attempt",
    buildMatchers: (nonce, execution) => [...base.buildMatchers(nonce, execution), ...antigravityModelReceiptMatchers(execution.profile.model)] };
  return {
    id: input.id, label: input.label, manualOnly: true,
    description: `One admission and one ordinary prompt per ${input.route} model; each cell requires the Runner's exact-model receipt to equal the requested ID.`,
    groups: ["native"],
    profiles: input.models.map(model => buildAntigravityProfile(deps, model, antigravityLineupProfileId(model))),
    environments: [deps.localEnvironment], tasks: [task], expectedMatrixSize: input.models.length,
    definitionMetadata: { version: 1, digest: definitionDigest(input.models), route: input.route, models: [...input.models],
      runtime: QUALIFIED_ACPX_PROFILES.antigravity.agentServerVersion, qualification: antigravityQualificationStatus(),
      receipt: "native-input-requested-and-effective-model-equal-requested-id", scheduling: "explicit-only", maximumAttemptsPerCell: 1 },
  };
}

