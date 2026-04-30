#!/usr/bin/env node
// One-off script: rename audit-log.md → audit-log.csv, delete ananya-gowdar-* test files
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env manually
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.paperclip/.env");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx === -1) continue;
  const key = trimmed.slice(0, idx).trim();
  const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  if (!process.env[key]) process.env[key] = val;
}

const { SharepointClient } = await import(
  "../packages/mcp-sharepoint/dist/client.js"
);
const { readConfigFromEnv } = await import(
  "../packages/mcp-sharepoint/dist/config.js"
);

const client = new SharepointClient(readConfigFromEnv());

// ── Task 1: rename audit-log.md → audit-log.csv ──────────────────────────────
console.log("\n[1] Checking audit-log state ...");
try {
  const csv = await client.getItemByPath("HR-Onboarding/audit-log.csv");
  console.log(`    ✓ audit-log.csv already exists — nothing to do (${csv.webUrl})`);
} catch {
  // .csv doesn't exist yet — try rename
  try {
    const result = await client.moveItem(
      "HR-Onboarding/audit-log.md",
      "HR-Onboarding",
      "audit-log.csv",
    );
    console.log(`    ✓ Renamed → ${result.name} (${result.webUrl})`);
  } catch (err) {
    console.log(`    ✗ Rename failed: ${err.message}`);
  }
}

// ── Task 2: delete ananya-gowdar-* test folders ───────────────────────────────
// List HR-Onboarding directly — more reliable than search path construction
console.log("\n[2] Listing HR-Onboarding/ to find ananya test folders ...");
const hrItems = await client.listByPath("HR-Onboarding");
const targets = hrItems.filter(i =>
  i.name.toLowerCase().includes("ananya") || i.name.toLowerCase().includes("gowdar")
);
console.log(`    Found ${targets.length} target(s) in HR-Onboarding/`);

if (targets.length === 0) {
  console.log("    ✓ Nothing to delete");
} else {
  for (const item of targets) {
    const fullPath = `HR-Onboarding/${item.name}`;
    console.log(`    Deleting: ${fullPath} (${item.webUrl ?? "no URL"})`);
    try {
      await client.deleteItem(fullPath);
      console.log(`    ✓ Deleted`);
    } catch (err) {
      console.log(`    ✗ Failed: ${err.message}`);
    }
  }
}

console.log("\nDone.");
