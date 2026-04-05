#!/usr/bin/env node
/**
 * Migrates managed agents (by name) to OpenCode + default free model (Qwen 3.6 Plus via `opencode/*`).
 * Legacy script name kept for Makefile/docs. Override model with PAPERCLIP_OPENCODE_QUOTA_FALLBACK_MODEL.
 *
 * Usage:
 *   PAPERCLIP_COMPANY_ID=<uuid> node scripts/rollout-codex-agent-presets.mjs
 *   PAPERCLIP_COMPANY_ID=<uuid> node scripts/rollout-codex-agent-presets.mjs --apply
 *   PAPERCLIP_COMPANY_ID=<uuid> node scripts/rollout-codex-agent-presets.mjs --apply --all-agents
 *
 * `--all-agents`: PATCH every `opencode_local` / `codex_local` agent in the company (not only name-matched roles).
 *
 * Env: PAPERCLIP_URL, PAPERCLIP_TOKEN, PAPERCLIP_OPENCODE_QUOTA_FALLBACK_MODEL
 */

import {
  fetchManagedNemotronRolloutPlan,
  fetchAllOpenCodeQuotaAgentsPlan,
  applyManagedNemotronPatches,
} from "./lib/run-managed-nemotron-rollout.mjs";
import { managedAgentNemotronPreset } from "./lib/agent-rollout-presets.mjs";

const baseUrl = (process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim();
const apply = process.argv.includes("--apply");
const allAgents = process.argv.includes("--all-agents");

function authHeaders() {
  const headers = { Accept: "application/json" };
  const token = process.env.PAPERCLIP_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function main() {
  if (!companyId) {
    console.error("Missing PAPERCLIP_COMPANY_ID.");
    process.exit(1);
  }

  let plan;
  try {
    plan = allAgents
      ? await fetchAllOpenCodeQuotaAgentsPlan({
          baseUrl,
          companyId,
          authHeaders: authHeaders(),
        })
      : await fetchManagedNemotronRolloutPlan({
          baseUrl,
          companyId,
          authHeaders: authHeaders(),
        });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const { model, targets, skipped } = plan;

  console.log(
    apply
      ? `APPLY: PATCH adapterType → opencode_local + free preset (${allAgents ? "all codex/opencode agents" : "name-matched roles only"})\n`
      : "DRY-RUN (pass --apply to PATCH)\n",
  );
  console.log(`Target model: ${model}\n`);

  if (targets.length === 0) {
    console.log("No matching codex_local / opencode_local agents (check PAPERCLIP_COMPANY_ID).");
  }

  for (const agent of targets) {
    const preset = managedAgentNemotronPreset(agent);
    const tag =
      agent.adapterType === "opencode_local" && agent.adapterConfig?.model === model
        ? "(already on target model)"
        : "UPDATE";
    const label = preset?.label ?? "—";
    console.log(`[${tag}] ${agent.name} (${label})  ${agent.adapterType}`);
  }

  if (skipped.length > 0) {
    console.log(
      allAgents
        ? "\nNot patched (other adapter types):"
        : "\nSkipped (local coding agent, no name rule):",
    );
    for (const a of skipped) {
      console.log(`  - ${a.name} (${a.adapterType})`);
    }
  }

  if (!apply) {
    console.log("\nNo requests sent. Use --apply after `opencode models` lists the target id.");
    return;
  }

  try {
    const { patched, failures } = await applyManagedNemotronPatches({
      baseUrl,
      authHeaders: authHeaders(),
      targets,
      model,
    });
    console.log(`\nDone. Patched ${patched} agent(s). Run "Test environment" per agent.`);
    if (failures.length > 0) {
      console.error("\nPATCH failures (other agents may have updated successfully):");
      for (const f of failures) {
        console.error(`  - ${f.name} (${f.id}): ${f.message}`);
      }
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
