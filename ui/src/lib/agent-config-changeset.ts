import type { Agent } from "@paperclipai/shared";
import type { AgentConfigOverlay } from "./agent-config-patch";

export type AgentConfigChange = {
  key: string;
  label: string;
  section: "Runtime" | "Environment" | "Schedule & Runs" | "Danger & Legacy";
  before: unknown;
  after: unknown;
};

export type OverlayGroup = "identity" | "adapterConfig" | "heartbeat" | "runtime";

/**
 * Structural value equality for overlay entries. Overlay values are plain config
 * primitives / arrays / small JSON objects, so a deep compare is enough to tell
 * "this edit restores the saved value" from a genuine change. Used to prune
 * no-op overlay entries (e.g. toggling a danger switch off then back on to its
 * saved value) so they don't surface as spurious `true -> true` History rows.
 */
export function agentConfigValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => agentConfigValuesEqual(item, b[index]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in bObj && agentConfigValuesEqual(aObj[key], bObj[key]));
}

export function labelForAgentConfigKey(key: string): string {
  return key.replace(/^.*\./, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (value) => value.toUpperCase());
}

function sectionForKey(key: string): AgentConfigChange["section"] {
  if (key === "defaultEnvironmentId" || key === "adapterConfig.env") return "Environment";
  if (key.startsWith("runtimeConfig.heartbeat.")) return "Schedule & Runs";
  if (/cwd|dangerouslySkipPermissions|dangerouslyBypassSandbox|dangerouslyBypassApprovalsAndSandbox/.test(key)) return "Danger & Legacy";
  return "Runtime";
}

export function originalValue(agent: Agent, group: OverlayGroup, field: string): unknown {
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
      changes.push({ key, label: labelForAgentConfigKey(key), section: sectionForKey(key), before: originalValue(agent, group, field), after });
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
  // Drop entries that restore the saved value — a no-op is never a real change,
  // regardless of which overlay path produced it (direct setOverlay writes for
  // adapter-type switches / access-grant edits bypass the mark() prune).
  return changes.filter((change) => !agentConfigValuesEqual(change.before, change.after));
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
