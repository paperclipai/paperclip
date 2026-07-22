import type { Agent } from "@paperclipai/shared";
import type { AgentConfigOverlay } from "./agent-config-patch";

export type AgentConfigChange = {
  key: string;
  label: string;
  section: "Runtime" | "Environment" | "Schedule & Runs" | "Danger & Legacy";
  before: unknown;
  after: unknown;
};

type OverlayGroup = "identity" | "adapterConfig" | "heartbeat" | "runtime";

function labelForKey(key: string): string {
  return key.replace(/^.*\./, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (value) => value.toUpperCase());
}

function sectionForKey(key: string): AgentConfigChange["section"] {
  if (key === "defaultEnvironmentId" || key === "adapterConfig.env") return "Environment";
  if (key.startsWith("runtimeConfig.heartbeat.")) return "Schedule & Runs";
  if (/cwd|dangerouslySkipPermissions|dangerouslyBypassSandbox|dangerouslyBypassApprovalsAndSandbox/.test(key)) return "Danger & Legacy";
  return "Runtime";
}

function originalValue(agent: Agent, group: OverlayGroup, field: string): unknown {
  if (group === "identity") return (agent as unknown as Record<string, unknown>)[field];
  if (group === "adapterConfig") return (agent.adapterConfig as Record<string, unknown> | null | undefined)?.[field];
  const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
  if (group === "heartbeat") return (runtimeConfig.heartbeat as Record<string, unknown> | null | undefined)?.[field];
  return runtimeConfig[field];
}

export function buildAgentConfigChanges(agent: Agent, overlay: AgentConfigOverlay): AgentConfigChange[] {
  const changes: AgentConfigChange[] = [];
  const addGroup = (group: OverlayGroup) => {
    for (const [field, after] of Object.entries(overlay[group])) {
      const key = group === "identity"
        ? field
        : group === "heartbeat"
          ? `runtimeConfig.heartbeat.${field}`
          : group === "runtime"
            ? field
            : `adapterConfig.${field}`;
      changes.push({ key, label: labelForKey(key), section: sectionForKey(key), before: originalValue(agent, group, field), after });
    }
  };
  addGroup("identity");
  if (overlay.adapterType !== undefined) changes.push({ key: "adapterType", label: "Adapter", section: "Runtime", before: agent.adapterType, after: overlay.adapterType });
  addGroup("adapterConfig");
  addGroup("heartbeat");
  addGroup("runtime");
  if (overlay.modelProfiles?.cheap !== undefined) {
    const profiles = ((agent.runtimeConfig ?? {}) as Record<string, unknown>).modelProfiles as Record<string, unknown> | undefined;
    changes.push({ key: "runtimeConfig.modelProfiles.cheap", label: "Cost saver model", section: "Runtime", before: profiles?.cheap, after: overlay.modelProfiles.cheap });
  }
  return changes;
}

export function revertAgentConfigChange(overlay: AgentConfigOverlay, key: string): AgentConfigOverlay {
  if (key === "adapterType") return { ...overlay, adapterType: undefined };
  if (key === "runtimeConfig.modelProfiles.cheap") return { ...overlay, modelProfiles: undefined };
  let group: OverlayGroup;
  let field: string;
  if (key.startsWith("adapterConfig.")) {
    group = "adapterConfig";
    field = key.slice("adapterConfig.".length);
  } else if (key.startsWith("runtimeConfig.heartbeat.")) {
    group = "heartbeat";
    field = key.slice("runtimeConfig.heartbeat.".length);
  } else if (key in overlay.identity) {
    group = "identity";
    field = key;
  } else if (key in overlay.runtime) {
    group = "runtime";
    field = key;
  } else {
    return overlay;
  }
  const nextGroup = { ...overlay[group] };
  delete nextGroup[field];
  return { ...overlay, [group]: nextGroup };
}

export function formatAgentConfigValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Not set";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
