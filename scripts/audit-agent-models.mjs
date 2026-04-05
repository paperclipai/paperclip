#!/usr/bin/env node
/**
 * Compares agent adapterConfig with latest heartbeat usageJson.model vs managed OpenCode free preset.
 *
 * Usage:
 *   PAPERCLIP_COMPANY_ID=<uuid> node scripts/audit-agent-models.mjs
 *   PAPERCLIP_COMPANY_ID=<uuid> node scripts/audit-agent-models.mjs --apply-nemotron
 *   PAPERCLIP_COMPANY_ID=<uuid> node scripts/audit-agent-models.mjs --apply-all
 *
 * `--apply-all`: PATCH every `opencode_local` / `codex_local` agent to the preset model (`--apply-nemotron` only updates name-matched roles).
 *
 * Aliases: --apply-codex and --apply-opencode mean the same as --apply-nemotron (deprecated names).
 *
 * RUNS_LIMIT — default 400
 */

import { managedAgentNemotronPreset, resolveOpencodeQuotaFallbackModel } from "./lib/agent-rollout-presets.mjs";
import {
  applyManagedNemotronPatches,
  applyOpencodeQuotaModelPatches,
  fetchAllOpenCodeQuotaAgentsPlan,
  fetchManagedNemotronRolloutPlan,
} from "./lib/run-managed-nemotron-rollout.mjs";

const baseUrl = (process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim();
const applyNemotron =
  process.argv.includes("--apply-nemotron") ||
  process.argv.includes("--apply-codex") ||
  process.argv.includes("--apply-opencode");
const applyAll = process.argv.includes("--apply-all");
const runsLimit = Math.min(
  1000,
  Math.max(1, parseInt(process.env.RUNS_LIMIT ?? "400", 10) || 400),
);

const OPENCODE_MODEL = resolveOpencodeQuotaFallbackModel();

function authHeaders() {
  const headers = { Accept: "application/json" };
  const token = process.env.PAPERCLIP_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseUsageModel(run) {
  if (!run?.usageJson) return null;
  const u = run.usageJson;
  const o = typeof u === "string" ? (() => { try { return JSON.parse(u); } catch { return null; } })() : u;
  if (!o || typeof o !== "object") return null;
  const m = o.model;
  return typeof m === "string" && m.trim() ? m.trim() : null;
}

function configEffort(agent) {
  const cfg = agent.adapterConfig && typeof agent.adapterConfig === "object" ? agent.adapterConfig : {};
  if (typeof cfg.modelReasoningEffort === "string") return cfg.modelReasoningEffort;
  if (typeof cfg.reasoningEffort === "string") return cfg.reasoningEffort;
  if (typeof cfg.variant === "string") return cfg.variant;
  return "";
}

async function main() {
  if (!companyId) {
    console.error("Missing PAPERCLIP_COMPANY_ID.");
    process.exit(1);
  }

  const agentsRes = await fetch(`${baseUrl}/api/companies/${companyId}/agents`, { headers: authHeaders() });
  if (!agentsRes.ok) {
    console.error(`GET agents -> ${agentsRes.status}`, (await agentsRes.text()).slice(0, 400));
    process.exit(1);
  }
  const agents = await agentsRes.json();
  if (!Array.isArray(agents)) {
    console.error("Expected agents array");
    process.exit(1);
  }

  const runsRes = await fetch(
    `${baseUrl}/api/companies/${companyId}/heartbeat-runs?limit=${runsLimit}`,
    { headers: authHeaders() },
  );
  if (!runsRes.ok) {
    console.error(`GET heartbeat-runs -> ${runsRes.status}`, (await runsRes.text()).slice(0, 400));
    process.exit(1);
  }
  const runs = await runsRes.json();
  if (!Array.isArray(runs)) {
    console.error("Expected heartbeat-runs array");
    process.exit(1);
  }

  const latestRunByAgent = new Map();
  for (const run of runs) {
    const aid = run.agentId;
    if (typeof aid !== "string" || !aid) continue;
    if (!latestRunByAgent.has(aid)) {
      latestRunByAgent.set(aid, run);
    }
  }

  console.log(
    `Audit: ${agents.length} agents, ${runs.length} runs scanned (latest per agent from newest run row).\n`,
  );
  console.log(
    "agent | adapter | config model | effort | preset (nemotron) | last run model | drift?\n" +
      "------+---------+--------------+--------+---------------------+----------------+-------",
  );

  for (const agent of agents) {
    if (agent.status === "terminated") continue;

    const cfg = agent.adapterConfig && typeof agent.adapterConfig === "object" ? agent.adapterConfig : {};
    const configModel = typeof cfg.model === "string" ? cfg.model : "";
    const effort = configEffort(agent);
    const preset = managedAgentNemotronPreset(agent);
    const presetStr = preset ? `${preset.model} (${preset.label})` : "—";

    const lastRun = latestRunByAgent.get(agent.id);
    const runModel = lastRun ? parseUsageModel(lastRun) : null;
    const runModelStr = runModel ?? "—";

    let drift = "";
    if (preset) {
      if (agent.adapterType !== "opencode_local" || configModel !== OPENCODE_MODEL) {
        drift = "config≠nemotron";
      } else if (runModel && runModel !== OPENCODE_MODEL) {
        drift = "run≠nemotron";
      }
    } else if (agent.adapterType === "opencode_local" && runModel && configModel && runModel !== configModel) {
      drift = "run≠config";
    }

    if (preset || runModel || configModel) {
      console.log(
        `${agent.name} | ${agent.adapterType} | ${configModel || "∅"} | ${effort || "∅"} | ${presetStr} | ${runModelStr} | ${drift || "—"}`,
      );
    }
  }

  console.log("");

  if (!applyNemotron && !applyAll) {
    console.log(
      "Dry-run. Apply:  pnpm audit:agent-models -- --apply-nemotron  (managed roles)  |  --apply-all  (all opencode/codex agents)",
    );
    return;
  }

  try {
    if (applyAll) {
      const plan = await fetchAllOpenCodeQuotaAgentsPlan({
        baseUrl,
        companyId,
        authHeaders: authHeaders(),
      });
      const { patched, failures } = await applyOpencodeQuotaModelPatches({
        baseUrl,
        authHeaders: authHeaders(),
        targets: plan.targets,
        model: plan.model,
      });
      console.log(`Done. Patched ${patched} agent(s) → opencode_local + ${plan.model} (all codex/opencode in company)`);
      if (failures.length > 0) {
        console.error("\nPATCH failures:");
        for (const f of failures) console.error(`  - ${f.name} (${f.id}): ${f.message}`);
        process.exit(1);
      }
      return;
    }

    const plan = await fetchManagedNemotronRolloutPlan({
      baseUrl,
      companyId,
      authHeaders: authHeaders(),
    });
    const { patched, failures } = await applyManagedNemotronPatches({
      baseUrl,
      authHeaders: authHeaders(),
      targets: plan.targets,
      model: plan.model,
    });
    console.log(`Done. Patched ${patched} agent(s) → opencode_local + ${plan.model}`);
    if (failures.length > 0) {
      console.error("\nPATCH failures:");
      for (const f of failures) console.error(`  - ${f.name} (${f.id}): ${f.message}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
