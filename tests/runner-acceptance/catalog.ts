import { createHash } from "node:crypto";

import { DEFAULT_CODEX_LOCAL_MODEL } from "../../packages/adapters/codex-local/src/index.js";
import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { QUALIFIED_OPENCODE_MODEL } from "../../packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.js";
import { BUILTIN_ADAPTER_TYPES } from "../../server/src/adapters/builtin-adapter-types.js";

import { findSensitiveValue } from "./redaction.js";
import type {
  JsonValue,
  RunnerAcceptanceCase,
  RunnerAcceptanceCell,
  RunnerAcceptanceProfile,
} from "./types.js";

const excludedBuiltInAdapterTypes = new Set(["paperclip_runner", "pi_local"]);

const directBuiltInAdapterTypes = [
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor_cloud",
  "cursor",
  "gemini_local",
  "grok_local",
  "hermes_gateway",
  "hermes_local",
  "kimi_local",
  "openclaw_gateway",
  "opencode_local",
  "process",
  "http",
] as const;

function directProfile(adapterType: string): RunnerAcceptanceProfile {
  return {
    id: `direct-${adapterType.replaceAll("_", "-")}`,
    label: `Direct ${adapterType}`,
    generation: "direct",
    adapterScope: "built_in",
    adapterType,
    expectedRuntimeMode: "legacy",
    provider: null,
    model: null,
    adapterConfig: {},
    invariants: [
      "runtime.mode=legacy",
      "runnerd.start_count=0",
      "native_record.count=0",
      "finalization.path=direct_adapter",
      "task_controls.mode=classic",
    ],
  };
}

function nativeProfile(input: {
  id: string;
  label: string;
  provider: "codex" | "opencode" | "acpx";
  model: string;
  adapterConfig: Record<string, JsonValue>;
}): RunnerAcceptanceProfile {
  return {
    ...input,
    generation: "native",
    adapterScope: "built_in",
    adapterType: "paperclip_runner",
    expectedRuntimeMode: "native",
    invariants: [
      "runtime.mode=native",
      "runnerd.start_count=1",
      "native_record.count>=1",
      "finalization.path=native",
      "provider.persisted=true",
    ],
  };
}

export const directAcceptanceProfiles: readonly RunnerAcceptanceProfile[] = [
  ...directBuiltInAdapterTypes.map(directProfile),
  {
    id: "direct-external-plugin-contract",
    label: "Direct external plugin contract",
    generation: "direct",
    adapterScope: "external_plugin_contract",
    adapterType: "external_plugin:*",
    expectedRuntimeMode: "legacy",
    provider: null,
    model: null,
    adapterConfig: {},
    invariants: [
      "runtime.mode=legacy",
      "runnerd.start_count=0",
      "native_record.count=0",
      "finalization.path=plugin_adapter",
      "task_controls.mode=classic",
    ],
  },
] as const;

export const nativeAcceptanceProfiles: readonly RunnerAcceptanceProfile[] = [
  nativeProfile({
    id: "runner-codex",
    label: "Paperclip Runner Codex",
    provider: "codex",
    model: DEFAULT_CODEX_LOCAL_MODEL,
    adapterConfig: {
      provider: "codex",
      codexPermissionMode: "untrusted",
      lifecycleMode: "per_turn",
    },
  }),
  nativeProfile({
    id: "runner-opencode",
    label: "Paperclip Runner OpenCode",
    provider: "opencode",
    model: QUALIFIED_OPENCODE_MODEL,
    adapterConfig: {
      provider: "opencode",
      model: QUALIFIED_OPENCODE_MODEL,
      opencodePermissionMode: "ask",
      lifecycleMode: "per_turn",
    },
  }),
  nativeProfile({
    id: "runner-acpx-claude",
    label: "Paperclip Runner ACPX Claude",
    provider: "acpx",
    model: QUALIFIED_ACPX_PROFILES.claude.qualificationModel,
    adapterConfig: {
      provider: "acpx",
      acpxAgent: "claude",
      model: QUALIFIED_ACPX_PROFILES.claude.qualificationModel,
      acpxPermissionMode: "approve-reads",
      lifecycleMode: "per_turn",
    },
  }),
  nativeProfile({
    id: "runner-acpx-codex",
    label: "Paperclip Runner ACPX Codex",
    provider: "acpx",
    model: QUALIFIED_ACPX_PROFILES.codex.qualificationModel,
    adapterConfig: {
      provider: "acpx",
      acpxAgent: "codex",
      model: QUALIFIED_ACPX_PROFILES.codex.qualificationModel,
      acpxPermissionMode: "approve-reads",
      lifecycleMode: "per_turn",
    },
  }),
] as const;

export const runnerAcceptanceProfiles: readonly RunnerAcceptanceProfile[] = [
  ...directAcceptanceProfiles,
  ...nativeAcceptanceProfiles,
];

export const runnerAcceptanceCases: readonly RunnerAcceptanceCase[] = [
  {
    id: "runtime-selection",
    label: "Runtime selection remains isolated",
    revision: 1,
    appliesTo: "all",
    assertions: [
      "runtime_selection.is_stable",
      "status_authority.matches_runtime",
      "execution_occurs_once",
    ],
  },
  {
    id: "task-thread-baseline",
    label: "Task thread preserves baseline behavior",
    revision: 1,
    appliesTo: "all",
    assertions: [
      "task_thread.active_state",
      "task_thread.settled_state",
      "task_thread.empty_transcript_state",
      "task_thread.classic_interface_state",
    ],
  },
  {
    id: "question-round-trip",
    label: "Structured question round trip",
    revision: 1,
    appliesTo: "all",
    assertions: [
      "question.rendered_once",
      "question.response_validated",
      "question.resume_occurs_once",
      "finalization.byte_stable",
    ],
  },
  {
    id: "flagged-native-recovery",
    label: "Persisted native recovery after flag change",
    revision: 1,
    appliesTo: "native",
    assertions: [
      "fresh_start.flag_required",
      "persisted_run.readable_when_disabled",
      "persisted_run.recoverable_when_disabled",
      "provider.identity_does_not_drift",
    ],
  },
] as const;

function suiteDefinitionHash() {
  return createHash("sha256")
    .update(JSON.stringify({
      profiles: runnerAcceptanceProfiles.map((profile) => ({
        id: profile.id,
        adapterType: profile.adapterType,
        generation: profile.generation,
        provider: profile.provider,
        model: profile.model,
        adapterConfig: profile.adapterConfig,
        invariants: profile.invariants,
      })),
      cases: runnerAcceptanceCases.map((acceptanceCase) => ({
        id: acceptanceCase.id,
        revision: acceptanceCase.revision,
        appliesTo: acceptanceCase.appliesTo,
        assertions: acceptanceCase.assertions,
      })),
    }))
    .digest("hex");
}

export const runnerAcceptanceSuiteDefinitionHash = suiteDefinitionHash();

export function buildRunnerAcceptanceMatrix(): RunnerAcceptanceCell[] {
  return runnerAcceptanceProfiles.flatMap((profile) =>
    runnerAcceptanceCases
      .filter((acceptanceCase) =>
        acceptanceCase.appliesTo === "all"
        || acceptanceCase.appliesTo === profile.generation)
      .map((acceptanceCase) => ({
        id: `${profile.id}.${acceptanceCase.id}`,
        suiteId: "runner-compatibility" as const,
        suiteDefinitionHash: runnerAcceptanceSuiteDefinitionHash,
        profile,
        acceptanceCase,
        assertions: [...new Set([
          ...profile.invariants,
          ...acceptanceCase.assertions,
        ])],
      })),
  );
}

function duplicates(values: readonly string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function assertSafeConfig(value: JsonValue, path = "adapterConfig") {
  if (typeof value === "string") {
    const leak = findSensitiveValue(value);
    if (leak) throw new Error(`Acceptance catalog contains ${leak} at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeConfig(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:authorization|api.?key|token|password|secret|credential|env)/i.test(key)) {
      throw new Error(`Acceptance catalog contains prohibited field ${path}.${key}`);
    }
    assertSafeConfig(entry, `${path}.${key}`);
  }
}

export function validateRunnerAcceptanceCatalog() {
  const duplicateProfileIds = duplicates(runnerAcceptanceProfiles.map(({ id }) => id));
  if (duplicateProfileIds.length > 0) {
    throw new Error(`Duplicate runner acceptance profile ids: ${duplicateProfileIds.join(", ")}`);
  }
  const duplicateCaseIds = duplicates(runnerAcceptanceCases.map(({ id }) => id));
  if (duplicateCaseIds.length > 0) {
    throw new Error(`Duplicate runner acceptance case ids: ${duplicateCaseIds.join(", ")}`);
  }

  const expectedDirectBuiltIns = new Set(
    [...BUILTIN_ADAPTER_TYPES].filter((type) => !excludedBuiltInAdapterTypes.has(type)),
  );
  const catalogedDirectBuiltIns = new Set(
    directAcceptanceProfiles
      .filter(({ adapterScope }) => adapterScope === "built_in")
      .map(({ adapterType }) => adapterType),
  );
  const missing = [...expectedDirectBuiltIns].filter((type) => !catalogedDirectBuiltIns.has(type));
  const unexpected = [...catalogedDirectBuiltIns].filter((type) => !expectedDirectBuiltIns.has(type));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Direct adapter catalog drift; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    );
  }

  for (const profile of runnerAcceptanceProfiles) {
    assertSafeConfig(profile.adapterConfig);
    if (profile.adapterType === "pi_local") {
      throw new Error("Pi is outside the acceptance foundation boundary");
    }
    if (
      profile.provider === "acpx"
      && profile.adapterConfig.acpxAgent !== "claude"
      && profile.adapterConfig.acpxAgent !== "codex"
    ) {
      throw new Error(`Unqualified ACPX profile ${profile.id}`);
    }
  }

  const matrix = buildRunnerAcceptanceMatrix();
  const duplicateCellIds = duplicates(matrix.map(({ id }) => id));
  if (duplicateCellIds.length > 0) {
    throw new Error(`Duplicate runner acceptance cell ids: ${duplicateCellIds.join(", ")}`);
  }
  return matrix;
}

export const runnerAcceptanceMatrix = validateRunnerAcceptanceCatalog();
