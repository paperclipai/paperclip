#!/usr/bin/env node
import { inventoryRecoveryFiles } from "./lib/recovery-cutover-inventory.mjs";

const usage = "Usage: node scripts/recovery-cutover.mjs --instance-root /absolute/instance [--orphan-directory /absolute/override] [--max-entries 10000] [--check]";
const args = process.argv.slice(2);
try {
  let instanceRoot;
  let orphanDirectory = process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR;
  let maxEntries = 10_000;
  let check = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (seen.has(argument)) throw new Error("duplicate");
    seen.add(argument);
    if (argument === "--check") check = true;
    else if (["--instance-root", "--orphan-directory", "--max-entries"].includes(argument)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("missing");
      if (argument === "--instance-root") instanceRoot = value;
      else if (argument === "--orphan-directory") orphanDirectory = value;
      else maxEntries = Number(value);
    } else throw new Error("unknown");
  }
  if (!instanceRoot) throw new Error("missing");
  const report = await inventoryRecoveryFiles({ instanceRoot, orphanDirectory, maxEntries });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (check && report.status !== "clear") process.exitCode = 1;
} catch {
  // Never echo args, filesystem errors or paths: they may contain secrets.
  process.stderr.write(`Recovery inventory could not run. ${usage}\n`);
  process.exitCode = 2;
}
