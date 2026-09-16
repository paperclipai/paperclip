import type { CreateConfigValues } from "../components/AgentConfigForm";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config";
import type { AgentPermissions } from "@paperclipai/shared";

export function buildNewAgentHirePayload(input: {
  name: string;
  effectiveRole: string;
  title?: string;
  reportsTo?: string | null;
  selectedSkillKeys?: string[];
  configValues: CreateConfigValues;
  adapterConfig: Record<string, unknown>;
  permissions?: Partial<AgentPermissions>;
}) {
  const {
    name,
    effectiveRole,
    title,
    reportsTo,
    selectedSkillKeys = [],
    configValues,
    adapterConfig,
    permissions,
  } = input;

  return {
    name: name.trim(),
    role: effectiveRole,
    ...(title?.trim() ? { title: title.trim() } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(selectedSkillKeys.length > 0 ? { desiredSkills: selectedSkillKeys } : {}),
    adapterType: configValues.adapterType,
    defaultEnvironmentId: configValues.defaultEnvironmentId ?? null,
    adapterConfig,
    runtimeConfig: buildNewAgentRuntimeConfig({
      heartbeatEnabled: configValues.heartbeatEnabled,
      intervalSec: configValues.intervalSec,
    }),
    budgetMonthlyCents: 0,
    ...(permissions ? { permissions } : {}),
    // The stored-session claim is not an agent column. The server derives the
    // owner from the actor and consumes the claim to bind the fixed OAuth token.
    // Send it only after a Claude subscription login reaches the `stored` state.
    ...(configValues.claudeStoredSessionId
      ? { storedSessionId: configValues.claudeStoredSessionId }
      : {}),
    // The apply-existing flag is not an agent column. The server binds the fixed
    // OAuth token reference to the owner stored value with no login round trip.
    // Send it only after the owner applies an existing stored login.
    ...(configValues.claudeApplyStoredLogin ? { applyStoredClaudeLogin: true } : {}),
  };
}
