import {
  buildNemotronOpenCodeAdapterConfig,
  managedAgentNemotronPreset,
  resolveOpencodeQuotaFallbackModel,
} from "./agent-rollout-presets.mjs";

export async function fetchManagedNemotronRolloutPlan({ baseUrl, companyId, authHeaders }) {
  const model = resolveOpencodeQuotaFallbackModel();

  const listUrl = `${baseUrl}/api/companies/${companyId}/agents`;
  const listRes = await fetch(listUrl, { headers: authHeaders });
  if (!listRes.ok) {
    const text = await listRes.text();
    throw new Error(`GET ${listUrl} -> ${listRes.status} ${text.slice(0, 500)}`);
  }

  const agents = await listRes.json();
  if (!Array.isArray(agents)) {
    throw new Error("Unexpected response: expected agents array");
  }

  const targets = agents.filter((a) => managedAgentNemotronPreset(a) !== null);
  const skipped = agents.filter(
    (a) =>
      (a.adapterType === "codex_local" || a.adapterType === "opencode_local") &&
      a.status !== "terminated" &&
      managedAgentNemotronPreset(a) === null,
  );

  return { model, targets, skipped, agents };
}

/** Every non-terminated agent on `codex_local` or `opencode_local` (for company-wide model alignment). */
export async function fetchAllOpenCodeQuotaAgentsPlan({ baseUrl, companyId, authHeaders }) {
  const model = resolveOpencodeQuotaFallbackModel();

  const listUrl = `${baseUrl}/api/companies/${companyId}/agents`;
  const listRes = await fetch(listUrl, { headers: authHeaders });
  if (!listRes.ok) {
    const text = await listRes.text();
    throw new Error(`GET ${listUrl} -> ${listRes.status} ${text.slice(0, 500)}`);
  }

  const agents = await listRes.json();
  if (!Array.isArray(agents)) {
    throw new Error("Unexpected response: expected agents array");
  }

  const targets = agents.filter(
    (a) =>
      a.status !== "terminated" &&
      (a.adapterType === "opencode_local" || a.adapterType === "codex_local"),
  );

  const skipped = agents.filter(
    (a) =>
      a.status !== "terminated" &&
      a.adapterType !== "opencode_local" &&
      a.adapterType !== "codex_local",
  );

  return { model, targets, skipped, agents };
}

/**
 * @returns {{ patched: number, failures: Array<{ id: string, name: string, message: string }> }}
 */
export async function applyOpencodeQuotaModelPatches({ baseUrl, authHeaders, targets, model }) {
  let patched = 0;
  const failures = [];
  for (const agent of targets) {
    if (
      agent.adapterType === "opencode_local" &&
      typeof agent.adapterConfig?.model === "string" &&
      agent.adapterConfig.model === model
    ) {
      continue;
    }

    const nextConfig = buildNemotronOpenCodeAdapterConfig(agent, model);
    const patchUrl = `${baseUrl}/api/agents/${agent.id}`;
    try {
      const patchRes = await fetch(patchUrl, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          adapterType: "opencode_local",
          adapterConfig: nextConfig,
        }),
      });

      if (!patchRes.ok) {
        const text = await patchRes.text();
        failures.push({
          id: agent.id,
          name: typeof agent.name === "string" ? agent.name : agent.id,
          message: `${patchRes.status} ${text.slice(0, 1200)}`,
        });
        continue;
      }
      patched += 1;
    } catch (err) {
      failures.push({
        id: agent.id,
        name: typeof agent.name === "string" ? agent.name : agent.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { patched, failures };
}

export async function applyManagedNemotronPatches({ baseUrl, authHeaders, targets, model }) {
  return applyOpencodeQuotaModelPatches({ baseUrl, authHeaders, targets, model });
}
