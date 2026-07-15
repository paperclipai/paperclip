import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("build artifact is content addressed and detects tampering", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-build-artifact-"));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  mkdirSync(path.join(source, "nested"), { recursive: true });
  mkdirSync(output);
  writeFileSync(path.join(source, "index.js"), "export const ok = true;\n");
  writeFileSync(path.join(source, "nested", "asset.txt"), "asset\n");

  const created = JSON.parse(execFileSync(process.execPath, [
    "scripts/ops/build-artifact.mjs", "create", "--source", source, "--output", output,
  ], { cwd: repoRoot, encoding: "utf8" }));
  assert.equal(created.status, "pass");
  const manifest = JSON.parse(readFileSync(created.manifestPath, "utf8"));
  assert.equal(manifest.artifactDigest, created.artifactDigest);
  assert.equal(manifest.fileCount, 2);

  const verified = JSON.parse(execFileSync(process.execPath, [
    "scripts/ops/build-artifact.mjs", "verify", "--artifact", created.artifactRoot,
    "--manifest", created.manifestPath,
  ], { cwd: repoRoot, encoding: "utf8" }));
  assert.equal(verified.status, "pass");

  writeFileSync(path.join(created.artifactRoot, "index.js"), "tampered\n");
  const tampered = spawnSync(process.execPath, [
    "scripts/ops/build-artifact.mjs", "verify", "--artifact", created.artifactRoot,
    "--manifest", created.manifestPath,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(tampered.status, 1);
  assert.equal(JSON.parse(tampered.stdout).status, "fail");
});

test("inventory is read-only, severity aware, and preserves orphan disposition", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-inventory-"));
  const keysDir = path.join(root, "keys");
  mkdirSync(keysDir);
  writeFileSync(path.join(keysDir, "agent-one.json"), "not-read-by-reconciler");
  writeFileSync(path.join(keysDir, "orphan.json"), "not-read-by-reconciler");
  const agentsFile = path.join(root, "agents.json");
  writeFileSync(agentsFile, JSON.stringify([{ id: "agent-1", status: "idle", adapterType: "openclaw_gateway",
    adapterConfig: { claimedApiKeyPath: "/redacted/agent-one.json", authToken: "must-not-leak" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }]));

  const result = spawnSync(process.execPath, [
    "scripts/ops/reconcile-agent-inventory.mjs", "--agents", agentsFile, "--keys-dir", keysDir,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "warn");
  assert.equal(report.mutationPerformed, false);
  assert.equal(report.findings[0].disposition, "retain_quarantined_pending_rotation_review");
  assert.doesNotMatch(result.stdout, /must-not-leak|not-read-by-reconciler/);

  const badAgents = JSON.parse(readFileSync(agentsFile, "utf8"));
  badAgents[0].runtimeConfig.heartbeat.enabled = true;
  writeFileSync(agentsFile, JSON.stringify(badAgents));
  const failed = spawnSync(process.execPath, [
    "scripts/ops/reconcile-agent-inventory.mjs", "--agents", agentsFile, "--keys-dir", keysDir,
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).status, "fail");
});
