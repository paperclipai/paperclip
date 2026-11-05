import { t } from "@/i18n";
import { agentRuntimeSettingsHarness, aiRuntimeConnectionBindingSchema, type Agent, type AiConnectionBinding, type AiConnectionList, type AiRuntimeConnectionBinding } from "@paperclipai/shared";

export const bulkAgentHarness = (agent: Agent) => agentRuntimeSettingsHarness(agent.adapterType, agent.adapterConfig);
export const agentDefaultModel = (agent: Agent) => typeof agent.adapterConfig.model === "string" ? agent.adapterConfig.model.trim() || null : null;
export const agentConnection = (agent: Agent) => aiRuntimeConnectionBindingSchema.safeParse(agent.runtimeConfig.aiConnection).data;
export const sameBinding = (a: AiRuntimeConnectionBinding | undefined, b: AiRuntimeConnectionBinding | undefined) => {
  const canonical = (value: AiRuntimeConnectionBinding | undefined) => JSON.stringify(value && Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
  return canonical(a) === canonical(b);
};

export function bulkAgentDisabledReason(agent: Agent): string | undefined {
  if (["terminated", "pending_approval"].includes(agent.status)) return t("display:copy_714d5a99e12f");
  if (agentConnection(agent)?.mode === "router") return t("display:copy_24588199bb99");
  if (!["codex_local", "claude_local", "gemini_local", "grok_local", "opencode_local", "hermes_local", "pi_local", "copilot_runtime", "antigravity_runtime", "cursor_local"].includes(bulkAgentHarness(agent))) return t("display:copy_162f294ba02e");
}

export function resolveBulkConnection(binding: AiConnectionBinding | undefined, accounts: AiConnectionList) {
  return accounts.connections.find(c => binding?.mode === "responsible_user"
    ? c.provider === binding.provider && c.isDefault && c.ownership === "personal" && c.ownerUserId === accounts.currentUserId
    : c.id === binding?.connectionId && c.grantId === binding?.grantId);
}

export function bulkConnectionName(binding: AiRuntimeConnectionBinding | undefined, accounts?: AiConnectionList) {
  if (!binding) return t("display:copy_d70c66cc4ced");
  if (binding.mode === "router") return t("display:copy_c4a7d283a8fc");
  if (binding.mode === "responsible_user") return t("display:copy_e46172b4d0e0");
  return accounts?.connections.find(c => c.id === binding.connectionId && c.grantId === binding.grantId)?.name ?? "Assigned connection";
}

/** Bound probes and mutations; failures belong to individual agents. */
export async function mapBulkAgents<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 4): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await fn(items[index]) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}
