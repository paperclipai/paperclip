import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_CLAUDE_LOCAL_SKIP_PERMISSIONS } from "@paperclipai/adapter-claude-local";
import {
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";

// ---------------------------------------------------------------------------
// Shared adapter-agnostic form defaults
// ---------------------------------------------------------------------------

export const defaultCreateValues: CreateConfigValues = {
  adapterType: "claude_local",
  cwd: "",
  instructionsFilePath: "",
  promptTemplate: "",
  model: "",
  thinkingEffort: "",
  chrome: false,
  dangerouslySkipPermissions: true,
  search: false,
  fastMode: false,
  dangerouslyBypassSandbox: false,
  command: "",
  args: "",
  extraArgs: "",
  envVars: "",
  envBindings: {},
  url: "",
  bootstrapPrompt: "",
  payloadTemplateJson: "",
  workspaceStrategyType: "project_primary",
  workspaceBaseRef: "",
  workspaceBranchTemplate: "",
  worktreeParentDir: "",
  runtimeServicesJson: "",
  maxTurnsPerRun: 1000,
  heartbeatEnabled: false,
  intervalSec: 300,
};

// ---------------------------------------------------------------------------
// Per-adapter default overrides — single source of truth for both NewAgent
// and OnboardingWizard flows.
//
// Only adapter-specific fields that deviate from `defaultCreateValues` need
// to be listed.  The merge in `getCreateValuesForAdapterType()` spreads the
// base defaults first, then overlays the adapter-specific patch so that
// explicit user values (provided separately) always win.
// ---------------------------------------------------------------------------

type AdapterDefaultOverrides = Partial<Omit<CreateConfigValues, "adapterType">>;

export const adapterConfigDefaults: Record<string, AdapterDefaultOverrides> = {
  claude_local: {
    dangerouslySkipPermissions: DEFAULT_CLAUDE_LOCAL_SKIP_PERMISSIONS,
  },
  opencode_local: {
    // OpenCode shares the skip-permissions default with Claude
    dangerouslySkipPermissions: DEFAULT_CLAUDE_LOCAL_SKIP_PERMISSIONS,
    model: "",
  },
  codex_local: {
    model: DEFAULT_CODEX_LOCAL_MODEL,
    dangerouslyBypassSandbox: DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  },
  gemini_local: {
    model: DEFAULT_GEMINI_LOCAL_MODEL,
  },
  cursor: {
    model: DEFAULT_CURSOR_LOCAL_MODEL,
  },
};

// ---------------------------------------------------------------------------
// Build a complete `CreateConfigValues` for a given adapter type by merging
// adapter-agnostic defaults with adapter-specific overrides.
//
// This replaces the per-file `createValuesForAdapterType()` functions that
// previously existed in `NewAgent.tsx` and inline in `OnboardingWizard.tsx`.
// ---------------------------------------------------------------------------

export function getCreateValuesForAdapterType(
  adapterType: CreateConfigValues["adapterType"],
): CreateConfigValues {
  const { adapterType: _discard, ...base } = defaultCreateValues;
  const overrides = adapterConfigDefaults[adapterType] ?? {};
  return { ...base, ...overrides, adapterType };
}
