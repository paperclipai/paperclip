import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { isAgentStatusInvokable, normalizeAgentUrlKey } from "@paperclipai/shared";
import { HttpError } from "../errors.js";

type BuiltInAgentKey = "briefs";

interface BuiltInAgentDefinition {
  key: BuiltInAgentKey;
  displayName: string;
  featureKeys: string[];
}

const BUILT_IN_AGENT_DEFINITIONS: Record<BuiltInAgentKey, BuiltInAgentDefinition> = {
  briefs: {
    key: "briefs",
    displayName: "Briefs Agent",
    featureKeys: ["briefs"],
  },
};

function missingBuiltInAgent(definition: BuiltInAgentDefinition) {
  return new HttpError(412, `Built-in agent is not configured: ${definition.key}`, {
    code: "built_in_agent_not_configured",
    key: definition.key,
    status: "not_provisioned",
    agentId: null,
    featureKeys: definition.featureKeys,
  });
}

function builtInPausedWarning(definition: BuiltInAgentDefinition, agent: typeof agents.$inferSelect) {
  return {
    code: "built_in_agent_paused" as const,
    key: definition.key,
    agentId: agent.id,
    message: `${definition.displayName} is paused.`,
    status: agent.status,
    pauseReason: agent.pauseReason,
  };
}

function builtInUnavailableWarning(definition: BuiltInAgentDefinition, agent: typeof agents.$inferSelect) {
  return {
    code: "built_in_agent_unavailable" as const,
    key: definition.key,
    agentId: agent.id,
    message: `${definition.displayName} is ${agent.status.replace(/_/g, " ")}.`,
    status: agent.status,
    pauseReason: agent.pauseReason,
  };
}

function builtInAgentWarning(definition: BuiltInAgentDefinition, agent: typeof agents.$inferSelect) {
  if (isAgentStatusInvokable(agent.status)) return null;
  if (agent.status === "paused") return builtInPausedWarning(definition, agent);
  return builtInUnavailableWarning(definition, agent);
}

function builtInAgentNameKey(definition: BuiltInAgentDefinition) {
  return normalizeAgentUrlKey(definition.displayName) ?? definition.key;
}

export function builtInAgentService(db: Db) {
  return {
    async requireBuiltInAgent(companyId: string, key: BuiltInAgentKey) {
      const definition = BUILT_IN_AGENT_DEFINITIONS[key];
      if (!definition) throw new HttpError(404, `Unknown built-in agent: ${key}`);

      const [metadataAgent] = await db.select()
        .from(agents)
        .where(and(
          eq(agents.companyId, companyId),
          or(
            sql`${agents.metadata}->'paperclipBuiltInAgent'->>'key' = ${key}`,
            sql`${agents.metadata}->>'builtInAgentKey' = ${key}`,
          ),
        ))
        .limit(1);
      const [fallbackAgent] = metadataAgent ? [] : await db.select()
        .from(agents)
        .where(and(
          eq(agents.companyId, companyId),
          sql`trim(both '-' from regexp_replace(lower(${agents.name}), '[^a-z0-9]+', '-', 'g')) = ${builtInAgentNameKey(definition)}`,
        ))
        .limit(1);

      const agent = metadataAgent ?? fallbackAgent;

      if (!agent) throw missingBuiltInAgent(definition);

      return {
        definition,
        agent,
        warning: builtInAgentWarning(definition, agent),
      };
    },
  };
}
