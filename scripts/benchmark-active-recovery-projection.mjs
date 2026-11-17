#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = name => process.argv.slice(2).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const baselineRef = argument("--baseline-ref");
if (!baselineRef) throw new Error("Pass --baseline-ref=<pre-change commit>. Use an isolated checkout.");
const baseline = execFileSync("git", ["rev-parse", "--verify", baselineRef], { cwd: root, encoding: "utf8" }).trim();
const evidenceParent = path.resolve(argument("--evidence-dir") ?? os.tmpdir());
mkdirSync(evidenceParent, { recursive: true });
const evidence = mkdtempSync(path.join(evidenceParent, "active-recovery-projection-"));
const recovery = path.join(root, "server/src/services/recovery");
const fixture = path.join(root, "server/src/__tests__/active-recovery-projection.benchmark.test.ts");
const targets = [path.join(recovery, ".bench-baseline-service.ts"), path.join(recovery, ".bench-baseline-disposition-repair.ts"), fixture];
for (const target of targets) if (existsSync(target)) throw new Error(`Refusing to replace existing file: ${target}`);
const original = name => execFileSync("git", ["show", `${baseline}:server/src/services/recovery/${name}.ts`], { cwd: root, encoding: "utf8" });
const sources = [
  original("service").replace('from "./disposition-repair.js"', 'from "./.bench-baseline-disposition-repair.js"'),
  original("disposition-repair"),
  readFileSync(path.join(root, "doc/benchmarks/fixtures/active-recovery-projection.fixture.ts"), "utf8"),
];
const created = [];
try {
  for (const [index, target] of targets.entries()) {
    writeFileSync(target, sources[index], { flag: "wx" });
    created.push(target);
  }
  writeFileSync(path.join(evidence, "provenance.json"), JSON.stringify({ baseline,
    treatment: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(),
    node: process.version, platform: process.platform, architecture: process.arch, evidence,
  }, null, 2));
  const filter = process.argv.includes("--proof-only") ? ["-t", "untimed count|records mixed current|reads late query"] : [];
  const result = spawnSync(process.execPath, ["../node_modules/vitest/vitest.mjs", "run",
    "src/__tests__/active-recovery-projection.benchmark.test.ts", ...filter], {
    cwd: path.join(root, "server"), env: { ...process.env, RECOVERY_EVIDENCE_DIR: evidence }, stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const target of created.reverse()) unlinkSync(target);
  process.stdout.write(`Evidence: ${evidence}\n`);
}
