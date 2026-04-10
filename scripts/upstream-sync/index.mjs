import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseSyncConfig } from './lib/config.mjs';
import { runUpstreamSync } from './lib/orchestrator.mjs';

export function formatOutputs(result) {
  return [
    `branch_name=${result.branchName ?? ''}`,
    `report_path=${result.reportPath ?? ''}`,
    `pr_body_path=${result.prBodyPath ?? ''}`,
    `status=${result.status ?? ''}`,
    `validation_status=${result.validationStatus ?? ''}`,
    `ready_for_pr=${String(result.readyForPr ?? false)}`,
    `validation_log_path=${result.validationLogPath ?? ''}`,
    '',
  ].join('\n');
}

export async function writeOutputs(
  result,
  stdout = process.stdout,
  {
    appendFileImpl = appendFile,
    githubOutputPath = process.env.GITHUB_OUTPUT,
  } = {},
) {
  const output = formatOutputs(result);
  stdout.write(output);

  if (githubOutputPath) {
    await appendFileImpl(githubOutputPath, output, 'utf8');
  }
}

export function resolveExitCode(result) {
  if (!result) {
    return 1;
  }

  if (result.status === 'error' || result.status === 'conflict') {
    return 1;
  }

  if (result.validationStatus === 'failed' || result.validationStatus === 'error') {
    return 1;
  }

  return 0;
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  {
    parseSyncConfig: parseSyncConfigImpl = parseSyncConfig,
    runUpstreamSync: runUpstreamSyncImpl = runUpstreamSync,
    stdout = process.stdout,
    appendFileImpl = appendFile,
  } = {},
) {
  const config = parseSyncConfigImpl(env, argv);
  const result = await runUpstreamSyncImpl({ config });

  await writeOutputs(result, stdout, {
    appendFileImpl,
    githubOutputPath: env.GITHUB_OUTPUT,
  });

  return result;
}

const invokedPath = process.argv[1];
const isDirectRun = invokedPath ? import.meta.url === pathToFileURL(invokedPath).href : false;

if (isDirectRun) {
  main()
    .then((result) => {
      process.exitCode = resolveExitCode(result);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
