import { resolvePiThinkingLevel, type PiThinkingLevel } from "./pi-thinking.js";
import type {
  HarnessDriverConfigValidation,
  HarnessDriverDescriptor,
} from "../../contracts/harness-driver.js";
import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import type { NativeSessionCapabilities, NativeTurnControlCapabilities } from "../../contracts/types.js";
import { providerFamilyCapabilities } from "../../provider-events.js";
import {
  ACPX_DRIVER_KIND,
  QUALIFIED_ACPX_VERSION,
  QUALIFIED_ACPX_PROFILES,
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "./qualified-profiles.js";

import { ACPX_CAPABILITY_PROFILES } from "./capability-profiles.js";

const ACPX_AGENTS = ["claude", "codex", "grok", "pi", "cursor", "copilot", "antigravity"] as const;
const ACPX_PERMISSION_MODES = [
  "approve-all",
  "approve-paperclip",
  "approve-reads",
  "deny-all",
] as const;
const ACPX_CONFIG_FIELDS = new Set(["agent", "model", "permissionMode", "piThinkingLevel"]);

export interface ValidatedAcpxDriverConfig extends Record<string, unknown> {
  agent: QualifiedAcpxAgent;
  model: string;
  permissionMode: NativeAcpxPermissionMode;
  piThinkingLevel?: PiThinkingLevel;
}

export function acpxCapabilities(
  agent: QualifiedAcpxAgent,
  negotiated?: NativeTurnControlCapabilities | null,
): NativeSessionCapabilities {
  const controls = agent === "pi" ? negotiated : null;
  const profile = ACPX_CAPABILITY_PROFILES[agent];
  if (QUALIFIED_ACPX_PROFILES[agent].qualificationStatus === "pending") return {
    resume: false, toolRefreshOnResume: false, typedEvents: false, steering: false, queuedFollowUp: false,
    interruption: false, structuredResult: false, read: false, reconciliation: false, usage: false,
    dynamicTools: false, runtimeRequestResolution: false, runtimeRequestHandoff: false, goals: false, threadLineage: false,
    unsupported: ["qualification_pending"],
  };
  return {
    resume: profile.recovery === "session-load",
    toolRefreshOnResume: profile.recovery === "session-load" && profile.toolRefreshOnResume === true,
    typedEvents: true,
    typedEventFamilies: providerFamilyCapabilities({
      plan: profile.plans === "semantic-only" ? "unsupported" : "available",
      tool_execution: "available",
      model_identity: "available",
      review: agent === "grok" ? "unsupported" : "available",
      provider_notice: agent === "grok" ? "unsupported" : "available",
      artifact: "policy_disabled",
    }),
    steering: controls?.steering === true,
    queuedFollowUp: controls?.queuedFollowUp === true,
    interruption: true,
    structuredResult: true,
    read: true,
    reconciliation: true,
    usage: profile.usage === "reported",
    dynamicTools: true,
    runtimeRequestResolution: profile.permissions === "interactive" || profile.questions === "form",
    runtimeRequestHandoff: true,
    goals: false,
    threadLineage: false,
    unsupported: [...(controls?.steering ? [] : ["steering"]), "goals", "threadLineage"],
  };
}

export function acpxDriverDescriptor(
  agent: QualifiedAcpxAgent,
): HarnessDriverDescriptor {
  const pending = QUALIFIED_ACPX_PROFILES[agent].qualificationStatus === "pending";
  return {
    kind: ACPX_DRIVER_KIND,
    displayName: `${displayAgent(agent)} via ACPX`,
    version: QUALIFIED_ACPX_VERSION,
    protocolVersion: "acp/v1",
    runtimeContextCapabilities: {
      instructions: pending ? "unsupported" : "native",
      skills: pending ? "unsupported" : "native",
      mcp: pending ? "unsupported" : "native",
    },
    capabilities: acpxCapabilities(agent),
  };
}

export function validateAcpxDriverConfig(
  value: unknown,
): HarnessDriverConfigValidation {
  const config = record(value);
  if (config === null) {
    return invalid("", "invalid_config", "ACPX config must be an object.");
  }
  const unknownField = Object.keys(config).find(
    (field) => !ACPX_CONFIG_FIELDS.has(field),
  );
  if (unknownField !== undefined) {
    return invalid(
      unknownField,
      "unknown_field",
      `ACPX config does not support ${unknownField}.`,
    );
  }

  const agent = text(config.agent);
  if (!isAcpxAgent(agent)) {
    return invalid(
      "agent",
      "invalid_agent",
      "ACPX agent must be claude, codex, grok, cursor, copilot, pi, or antigravity.",
    );
  }
  if (ACPX_CAPABILITY_PROFILES[agent].qualification !== "qualified") {
    return invalid("agent", "qualification_pending", `${ACPX_CAPABILITY_PROFILES[agent].displayName} requires native Runner acceptance before use.`);
  }
  const model = text(config.model);
  try {
    resolveQualifiedAcpxProfile(agent, model);
  } catch (error) {
    return invalid("model", "invalid_model", safeErrorMessage(error));
  }
  const permissionMode = Object.prototype.hasOwnProperty.call(
    config,
    "permissionMode",
  )
    ? text(config.permissionMode)
    : "approve-all";
  if (!isPermissionMode(permissionMode)) {
    return invalid(
      "permissionMode",
      "invalid_permission_mode",
      "ACPX permission mode must be approve-all, approve-paperclip, approve-reads, or deny-all.",
    );
  }

  let piThinkingLevel: PiThinkingLevel | undefined;
  try { piThinkingLevel = resolvePiThinkingLevel(agent, config.piThinkingLevel); } catch (error) { return invalid("piThinkingLevel", "invalid_pi_thinking_level", safeErrorMessage(error)); }
  const validated: ValidatedAcpxDriverConfig = {
    agent,
    model,
    permissionMode,
    ...(piThinkingLevel === undefined ? {} : { piThinkingLevel }),
  };
  return { ok: true, config: validated, issues: [] };
}

function invalid(
  path: string,
  code: string,
  message: string,
): HarnessDriverConfigValidation {
  return { ok: false, config: null, issues: [{ path, code, message }] };
}

function isAcpxAgent(value: string): value is QualifiedAcpxAgent {
  return (ACPX_AGENTS as readonly string[]).includes(value);
}

function isPermissionMode(value: string): value is NativeAcpxPermissionMode {
  return (ACPX_PERMISSION_MODES as readonly string[]).includes(value);
}

function displayAgent(agent: QualifiedAcpxAgent): string {
  return ACPX_CAPABILITY_PROFILES[agent].displayName;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : "Invalid model.";
}
