#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const includeGated = args.includes("--include-gated");
const passthrough = args.filter((arg) => arg !== "--include-gated");

const grep = includeGated ? "@mcp-us" : "@mcp-runnable";
const result = spawnSync(
  "npx",
  [
    "playwright",
    "test",
    "--config",
    "tests/e2e/playwright.config.ts",
    "tests/e2e/mcp-user-stories.spec.ts",
    "--grep",
    grep,
    ...passthrough,
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);

if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
