#!/usr/bin/env node
/**
 * CI guard: MCP tool schemas vs REST route validators.
 *
 * Bundles packages/mcp-server/src/schema-drift.ts with esbuild (already a repo
 * dependency) and runs the structural comparison. Exits non-zero when a tool's
 * input schema has drifted from the shared zod validator its REST route uses.
 *
 * Runs standalone (no vitest), so it works as an explicit, fast CI step and can
 * be run locally with `pnpm run check:mcp-schema-drift`.
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "packages", "mcp-server", "src", "schema-drift.ts");

async function main() {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
  });

  const dir = mkdtempSync(path.join(tmpdir(), "mcp-schema-drift-"));
  const outFile = path.join(dir, "schema-drift.mjs");
  try {
    writeFileSync(outFile, result.outputFiles[0].text);
    const mod = await import(pathToFileURL(outFile).href);
    const violations = mod.collectSchemaDriftViolations();
    const cases = mod.SCHEMA_DRIFT_CASES.length;

    if (violations.length === 0) {
      console.log(`✓ MCP schema-drift check passed: ${cases} tool/REST schema pairs in sync.`);
      return;
    }

    console.error(
      `✗ MCP schema-drift check failed: ${violations.length} of ${cases} tool/REST schema pairs drifted.\n`,
    );
    console.error(mod.formatViolations(violations));
    console.error(
      "\nEach line above is a structural difference between an MCP tool's input schema and the\n" +
        "shared zod validator its REST route enforces. Reconcile the tool schema in\n" +
        "packages/mcp-server/src/tools.ts with the validator in @paperclipai/shared, or — if the\n" +
        "difference is intentional — add it to the case's `allowedDiffs` (with a reason) in\n" +
        "packages/mcp-server/src/schema-drift.ts.",
    );
    process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("MCP schema-drift check crashed:", error);
  process.exit(1);
});
