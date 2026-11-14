import { createHmac } from "node:crypto";
import { agentConfigurationSpec, canonicalAgentConfiguration, type AgentConfigurationSource } from "@paperclipai/shared";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { unprocessable } from "../errors.js";
import { resolveDecisionSigningSecret } from "../services/decision-signing.js";

export function agentConfigurationRevision(agent: AgentConfigurationSource & { permissions: Record<string, unknown> }) {
  return createHmac("sha256", resolveDecisionSigningSecret()).update("agent-configuration-v1:").update(canonicalAgentConfiguration({
    id: agent.id, ...agentConfigurationSpec(agent), permissions: normalizeAgentPermissions(agent.permissions),
  })).digest("hex");
}

export function restoreAgentConfigurationRedactions(requested: unknown, saved: unknown, displayed: unknown): unknown {
  if (canonicalAgentConfiguration(requested) === canonicalAgentConfiguration(displayed)) return saved;
  if (typeof requested === "string" && requested.includes(REDACTED_EVENT_VALUE)) {
    throw unprocessable("A redacted value was changed or moved. Keep it unchanged, remove it, or replace the entire value.");
  }
  if (Array.isArray(requested)) {
    return requested.map((value, index) => restoreAgentConfigurationRedactions(value,
      Array.isArray(saved) ? saved[index] : undefined, Array.isArray(displayed) ? displayed[index] : undefined));
  }
  if (requested && typeof requested === "object") {
    const previous = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
    const redacted = displayed && typeof displayed === "object" ? displayed as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(requested).map(([key, value]) => [key,
      restoreAgentConfigurationRedactions(value, Object.hasOwn(previous, key) ? previous[key] : undefined,
        Object.hasOwn(redacted, key) ? redacted[key] : undefined),
    ]));
  }
  return requested;
}
