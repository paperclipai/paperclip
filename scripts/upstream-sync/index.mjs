import { pathToFileURL } from 'node:url';
import { parseSyncConfig } from './lib/config.mjs';
import { runUpstreamSync } from './lib/orchestrator.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseSyncConfig(env, argv);
  const result = await runUpstreamSync({ config });

  process.stdout.write(`branch_name=${result.branchName}\n`);
  process.stdout.write(`report_path=${result.reportPath}\n`);
  process.stdout.write(`pr_body_path=${result.prBodyPath}\n`);
  process.stdout.write(`status=${result.status}\n`);

  return result;
}

const invokedPath = process.argv[1];
const isDirectRun = invokedPath ? import.meta.url === pathToFileURL(invokedPath).href : false;

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
