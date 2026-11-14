#!/usr/bin/env node
// On-demand crash-point suite (durable ownership plan, Phase 5).
// Usage: node scripts/crash-points.mjs [--list] [--points <glob,...>] [--kinds <id,...>]
//          [--adapters codex,claude,opencode] [--workloads A1,B1,B5,C1] [--nth N] [--env local|daytona]
// See tests/restart-chaos/README.md, "Crash-point suite". Load provider keys
// into this process only: set -a; source ~/.secrets; set +a
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [
  path.join(root, "cli/node_modules/tsx/dist/cli.mjs"),
  path.join(root, "tests/restart-chaos/crash-points.ts"),
  ...process.argv.slice(2),
], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 2);
