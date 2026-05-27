#!/usr/bin/env node

import { formatTextReport, parseArgs, runSeedBank, usage } from "./seed_bank_core.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const result = await runSeedBank(options);
  if (options.outputJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatTextReport(result));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
