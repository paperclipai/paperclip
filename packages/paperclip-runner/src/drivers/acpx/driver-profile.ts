import type {
  HarnessDriverConfigValidation,
  HarnessDriverDescriptor,
} from "../../contracts/harness-driver.js";
import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import type { NativeSessionCapabilities } from "../../contracts/types.js";
import { providerFamilyCapabilities } from "../../provider-events.js";
import {
  ACPX_DRIVER_KIND,
  QUALIFIED_ACPX_VERSION,
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "./qualified-profiles.js";

const ACPX_AGENTS = ["pi", "claude", "codex"] as const;
const ACPX_PERMISSION_MODES = [
  "approve-all",
  "approve-reads",
  "deny-all",
] as const;
const ACPX_CONFIG_FIELDS = new Set(["agent", "model", "permissionMode"]);

export interface ValidatedAcpxDriverConfig extends Record<string, unknown> {
  agent: QualifiedAcpxAgent;
  model: string;
  permissionMode: NativeAcpxPermissionMode;
}

export function acpxCapabilities(
  agent: QualifiedAcpxAgent,
): NativeSessionCapabilities {
  return {
    resume: true,
    typedEvents: true,
    typedEventFamilies: providerFamilyCapabilities({
      plan: agent === "pi" ? "unsupported" : "available",
      tool_execution: "available",
      model_identity: "available",
      review: "available",
      provider_notice: "available",
      artifact: "policy_disabled",
    }),
    steering: false,
    interruption: true,
    structuredResult: true,
    read: true,
    reconciliation: true,
    usage: true,
    dynamicTools: true,
    runtimeRequestResolution: true,
    runtimeRequestHandoff: true,
    goals: false,
    threadLineage: false,
    unsupported: ["steering", "goals", "threadLineage"],
  };
}

export function acpxDriverDescriptor(
  agent: QualifiedAcpxAgent,
): HarnessDriverDescriptor {
  return {
    kind: ACPX_DRIVER_KIND,
    displayName: `${displayAgent(agent)} via ACPX`,
    version: QUALIFIED_ACPX_VERSION,
    protocolVersion: "acp/v1",
    runtimeContextCapabilities: {
      instructions: "native",
      skills: "native",
      mcp: "native",
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
      "ACPX agent must be pi, claude, or codex.",
    );
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
      "ACPX permission mode must be approve-all, approve-reads, or deny-all.",
    );
  }

  const validated: ValidatedAcpxDriverConfig = {
    agent,
    model,
    permissionMode,
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
  if (agent === "pi") return "Pi";
  if (agent === "claude") return "Claude";
  return "Codex";
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
