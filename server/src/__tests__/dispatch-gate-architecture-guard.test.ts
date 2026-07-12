import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverSrcDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * Files allowed to launch a real `claude` process or call the raw Claude
 * login helper directly, because each one mediates through the shared
 * dispatch gate (acquireDispatchGate/withDispatchGate) immediately beforehand
 * — verified below, not just allowlisted by filename.
 */
const RAW_CLAUDE_LAUNCH_ALLOWLIST = new Set([
  path.join("routes", "board-chat.ts"),
  path.join("routes", "agents.ts"),
]);

/**
 * Files allowed to import the unwrapped inference-launching exports
 * (`execute`, `testEnvironment`, `runClaudeLogin`) from the adapter package
 * directly. Other exports of that package (e.g. `claudeConfigDir`,
 * `parseClaudeStreamJson`) are read-only and not restricted. Both entries
 * below are verified elsewhere: registry.ts is the primary boundary that
 * composes the gate around them; agents.ts's raw `runClaudeLogin` import is
 * proven gated by the previous test.
 */
const UNDERLYING_ADAPTER_IMPORT_ALLOWLIST = new Set([
  path.join("adapters", "registry.ts"),
  path.join("routes", "agents.ts"),
]);
const DANGEROUS_ADAPTER_IMPORT_NAMES = ["execute", "testEnvironment", "runClaudeLogin"];

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("dispatch gate static architecture guard", () => {
  const files = listTsFiles(serverSrcDir);

  it("only allowlisted files spawn/execFile a literal \"claude\" process", () => {
    const offenders: string[] = [];
    const rawSpawnPattern = /\b(?:spawn|execFile)\s*\(\s*["']claude["']/g;

    for (const file of files) {
      const rel = path.relative(serverSrcDir, file);
      const content = readFileSync(file, "utf8");
      if (rawSpawnPattern.test(content) && !RAW_CLAUDE_LAUNCH_ALLOWLIST.has(rel)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("allowlisted raw launch sites call the dispatch gate before spawning", () => {
    for (const rel of RAW_CLAUDE_LAUNCH_ALLOWLIST) {
      const content = readFileSync(path.join(serverSrcDir, rel), "utf8");
      const gateIndex = content.indexOf("acquireDispatchGate(");
      expect(gateIndex, `${rel} must call acquireDispatchGate`).toBeGreaterThan(-1);

      const launchIndex = Math.max(
        content.indexOf('spawn("claude"'),
        content.indexOf("runClaudeLogin("),
      );
      expect(launchIndex, `${rel} must contain a raw Claude launch call`).toBeGreaterThan(-1);
      expect(gateIndex, `${rel} must acquire the gate before launching`).toBeLessThan(launchIndex);
    }
  });

  it("only the adapter registry imports the unwrapped adapter-package execute/login", () => {
    const offenders: string[] = [];
    // Read-only exports (claudeConfigDir, parseClaudeStreamJson, ...) from the
    // same module are unrestricted; only the inference-launching exports matter.
    const importBlockPattern = /import\s*\{([^}]*)\}\s*from\s*["']@paperclipai\/adapter-claude-local\/server["']/g;

    for (const file of files) {
      const rel = path.relative(serverSrcDir, file);
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(importBlockPattern)) {
        const names = match[1] ?? "";
        const importsDangerousName = DANGEROUS_ADAPTER_IMPORT_NAMES.some((name) =>
          new RegExp(`\\b${name}\\b`).test(names),
        );
        if (importsDangerousName && !UNDERLYING_ADAPTER_IMPORT_ALLOWLIST.has(rel)) {
          offenders.push(rel);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // Read-only, non-inference operations are exempt from the gate: `claude
  // --help`, `claude auth status`, and provider quota-window reads
  // (getQuotaWindows in services/quota-windows.ts). None of these appear as
  // raw spawn/execFile literals in server/src, so there is nothing to
  // allowlist for them above. The hello probe itself IS inference and is not
  // exempt — it is covered by the runtime acceptance tests in
  // dispatch-gate.test.ts, which assert adapter.testEnvironment is blocked
  // while the gate is active.
});
