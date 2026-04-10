import { pathToFileURL } from 'node:url';
import { parseSyncConfig } from './lib/config.mjs';
import { runUpstreamSync } from './lib/orchestrator.mjs';

export function writeOutputs(result, stdout = process.stdout) {
  stdout.write(`branch_name=${result.branchName}\n`);
  stdout.write(`report_path=${result.reportPath}\n`);
  stdout.write(`pr_body_path=${result.prBodyPath}\n`);
  stdout.write(`status=${result.status}\n`);
  stdout.write(`validation_status=${result.validationStatus ?? ''}\n`);
  stdout.write(`ready_for_pr=${String(result.readyForPr ?? false)}\n`);
  stdout.write(`validation_log_path=${result.validationLogPath ?? ''}\n`);
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  {
    parseSyncConfig: parseSyncConfigImpl = parseSyncConfig,
    runUpstreamSync: runUpstreamSyncImpl = runUpstreamSync,
    stdout = process.stdout,
  } = {},
) {
  const config = parseSyncConfigImpl(env, argv);
  const result = await runUpstreamSyncImpl({ config });

  writeOutputs(result, stdout);

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
