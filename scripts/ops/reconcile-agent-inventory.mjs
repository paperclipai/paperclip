#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];

function normalizeAgents(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.agents)) return value.agents;
  throw new Error("Agent inventory must be an array or an object with an agents array");
}

function summary(findings) {
  const counts = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

try {
  const agentsFile = option("--agents");
  const keysDir = option("--keys-dir");
  if (!agentsFile || !keysDir) throw new Error("Usage: reconcile-agent-inventory.mjs --agents <redacted-json> --keys-dir <dir>");
  const agents = normalizeAgents(JSON.parse(await readFile(path.resolve(agentsFile), "utf8")));
  const keyFiles = (await readdir(path.resolve(keysDir), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const claims = new Map();
  const findings = [];

  for (const agent of agents) {
    if (agent.adapterType !== "openclaw_gateway" || agent.status === "terminated") continue;
    const heartbeat = agent.runtimeConfig?.heartbeat ?? {};
    if (heartbeat.enabled !== false || heartbeat.wakeOnDemand !== true) {
      findings.push({
        severity: "error",
        code: "scheduled_heartbeat_not_disabled",
        agentId: agent.id,
        disposition: "disable_timer_keep_on_demand",
      });
    }
    const claimed = agent.adapterConfig?.claimedApiKeyPath;
    if (typeof claimed !== "string" || !claimed.trim()) {
      findings.push({ severity: "error", code: "missing_key_claim", agentId: agent.id, disposition: "provision_before_enable" });
      continue;
    }
    const filename = path.basename(claimed);
    const owners = claims.get(filename) ?? [];
    owners.push(agent.id);
    claims.set(filename, owners);
    if (!keyFiles.includes(filename)) {
      findings.push({ severity: "critical", code: "claimed_key_missing", agentId: agent.id, keyFile: filename, disposition: "keep_agent_frozen" });
    }
  }

  for (const [keyFile, owners] of claims) {
    if (owners.length > 1) findings.push({ severity: "critical", code: "duplicate_key_claim", keyFile, agentIds: owners, disposition: "rotate_before_enable" });
  }
  for (const keyFile of keyFiles) {
    if (!claims.has(keyFile)) findings.push({
      severity: "warning",
      code: "orphan_key_file",
      keyFile,
      disposition: "retain_quarantined_pending_rotation_review",
    });
  }

  const counts = summary(findings);
  const report = {
    schemaVersion: 1,
    status: counts.critical + counts.error > 0 ? "fail" : counts.warning > 0 ? "warn" : "pass",
    agentCount: agents.length,
    keyFileCount: keyFiles.length,
    summary: counts,
    findings,
    mutationPerformed: false,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === "fail") process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
