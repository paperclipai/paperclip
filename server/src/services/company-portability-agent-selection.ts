import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";

interface ExportAgentCandidate {
  id: string;
  name: string;
  status: string;
  metadata: unknown;
}

export function resolvePortableExportAgentSelection<T extends ExportAgentCandidate>(
  allAgentRows: T[],
  selectors: string[] | undefined,
  includeAgents: boolean,
): { agents: T[]; warnings: string[] } {
  const warnings: string[] = [];
  const liveAgentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
  const builtInAgentRows = liveAgentRows.filter((agent) => readBuiltInAgentMarker(agent.metadata));
  const portableAgentRows = liveAgentRows.filter((agent) => !readBuiltInAgentMarker(agent.metadata));

  if (includeAgents) {
    const skipped = allAgentRows.length - liveAgentRows.length;
    if (skipped > 0) {
      warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
    }
    if (builtInAgentRows.length > 0) {
      warnings.push(`Skipped ${builtInAgentRows.length} built-in managed agent${builtInAgentRows.length === 1 ? "" : "s"} from export.`);
    }
  }

  const agentByReference = new Map<string, T>();
  const builtInAgentByReference = new Map<string, T>();
  const addAgentReferences = (map: Map<string, T>, agent: T) => {
    map.set(agent.id, agent);
    map.set(agent.name, agent);
    const normalizedName = normalizeAgentUrlKey(agent.name);
    if (normalizedName) map.set(normalizedName, agent);
  };
  for (const agent of portableAgentRows) addAgentReferences(agentByReference, agent);
  for (const agent of builtInAgentRows) addAgentReferences(builtInAgentByReference, agent);

  const selectedAgents = new Map<string, T>();
  for (const selector of selectors ?? []) {
    const trimmed = selector.trim();
    if (!trimmed) continue;
    const normalized = normalizeAgentUrlKey(trimmed) ?? trimmed;
    const match = agentByReference.get(trimmed) ?? agentByReference.get(normalized);
    if (!match) {
      const builtInMatch = builtInAgentByReference.get(trimmed) ?? builtInAgentByReference.get(normalized);
      if (builtInMatch) {
        warnings.push(`Agent selector "${selector}" is a built-in managed agent and was skipped.`);
      } else {
        warnings.push(`Agent selector "${selector}" was not found and was skipped.`);
      }
      continue;
    }
    selectedAgents.set(match.id, match);
  }

  // Preserve the established compatibility behavior: no effective explicit
  // selection falls back to every portable agent when agent export is enabled.
  if (includeAgents && selectedAgents.size === 0) {
    for (const agent of portableAgentRows) selectedAgents.set(agent.id, agent);
  }

  return { agents: Array.from(selectedAgents.values()), warnings };
}
