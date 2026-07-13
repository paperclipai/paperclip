import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverSrcDir = fileURLToPath(new URL("..", import.meta.url));

/** Every distinct shape of a real Claude inference launch we scan for. */
const LAUNCH_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'spawn/execFile("claude")', regex: /\b(?:spawn|execFile)\s*\(\s*["']claude["']/g },
  { name: "runClaudeLogin(", regex: /\brunClaudeLogin\s*\(/g },
];

/**
 * Exact file + exact pattern + exact expected occurrence count. This is
 * intentionally a strict equality, not a ceiling: a second, later occurrence
 * of an already-approved pattern in an already-approved file fails the check
 * just as loudly as an occurrence in a brand-new file would — approval never
 * extends past the specific occurrence(s) enumerated here. Both entries are
 * verified below to be individually preceded by acquireDispatchGate(.
 */
const APPROVED_LAUNCH_SITES: { file: string; patternName: string; expectedCount: number }[] = [
  { file: path.join("routes", "board-chat.ts"), patternName: 'spawn/execFile("claude")', expectedCount: 1 },
  { file: path.join("routes", "agents.ts"), patternName: "runClaudeLogin(", expectedCount: 1 },
];

/**
 * Files allowed to import the unwrapped inference-launching exports
 * (`execute`, `testEnvironment`, `runClaudeLogin`) from the adapter package
 * directly. Other exports of that package (e.g. `claudeConfigDir`,
 * `parseClaudeStreamJson`) are read-only and not restricted. Both entries
 * below are verified elsewhere: registry.ts is the primary boundary that
 * composes the gate around them; agents.ts's raw `runClaudeLogin` import is
 * proven gated below.
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

  it("enumerates every Claude launch occurrence per file+pattern and accepts only the exact approved count, each individually gated", () => {
    const offenders: string[] = [];
    // file -> patternName -> match indices, so every occurrence (not just the
    // first) is accounted for, and an approved file gets no free pass for a
    // second, later, ungated occurrence of the same or a different pattern.
    const occurrencesByFileAndPattern = new Map<string, Map<string, number[]>>();

    for (const file of files) {
      const rel = path.relative(serverSrcDir, file);
      const content = readFileSync(file, "utf8");
      const gateIndex = content.indexOf("acquireDispatchGate(");

      for (const { name, regex } of LAUNCH_PATTERNS) {
        const indices = [...content.matchAll(regex)].map((match) => match.index ?? -1);
        if (indices.length === 0) continue;

        const approved = APPROVED_LAUNCH_SITES.find((site) => site.file === rel && site.patternName === name);
        if (!approved) {
          offenders.push(`${rel}: found ${indices.length} unapproved occurrence(s) of ${name}`);
        } else if (indices.length !== approved.expectedCount) {
          offenders.push(
            `${rel}: expected exactly ${approved.expectedCount} occurrence(s) of ${name}, found ${indices.length}`,
          );
        }

        for (const index of indices) {
          if (gateIndex === -1 || gateIndex > index) {
            offenders.push(`${rel}: occurrence of ${name} at index ${index} is not preceded by acquireDispatchGate(`);
          }
        }

        const byPattern = occurrencesByFileAndPattern.get(rel) ?? new Map<string, number[]>();
        byPattern.set(name, indices);
        occurrencesByFileAndPattern.set(rel, byPattern);
      }
    }

    // An approval that no longer matches anything (e.g. the call site was
    // removed or renamed) is stale and must be pruned rather than left as a
    // silently-unused exemption.
    for (const site of APPROVED_LAUNCH_SITES) {
      const found = occurrencesByFileAndPattern.get(site.file)?.get(site.patternName)?.length ?? 0;
      if (found === 0) {
        offenders.push(`${site.file}: approved pattern ${site.patternName} no longer matches anything — stale approval`);
      }
    }

    expect(offenders).toEqual([]);
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
  // --help` (see packages/adapters/claude-local/src/server/cli-capabilities.ts,
  // claudeCommandSupportsEffortFlag), `claude auth status`, and provider
  // quota-window reads (getQuotaWindows in services/quota-windows.ts). None of
  // these appear as raw spawn/execFile literals in server/src, so there is
  // nothing to allowlist for them above. The hello probe itself IS inference
  // and is gated via the adapter's runInferenceProbe hook (registry.ts's
  // runClaudeHelloProbeThroughGate) — covered by the runtime acceptance tests
  // in dispatch-gate.test.ts, which assert the probe is skipped while the
  // gate is active but the surrounding read-only checks still run.
});
