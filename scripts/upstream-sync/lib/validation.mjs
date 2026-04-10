import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const VALIDATION_LOG_PATH = 'reports/upstream-sync-validation-log.json';

const VALIDATION_CHECKS = [
  {
    key: 'uiTypecheck',
    label: 'UI typecheck',
    command: 'pnpm',
    args: ['--filter', '@paperclipai/ui', 'typecheck'],
  },
  {
    key: 'serverTypecheck',
    label: 'Server typecheck',
    command: 'pnpm',
    args: ['--filter', '@paperclipai/server', 'typecheck'],
  },
  {
    key: 'checkI18n',
    label: 'check:i18n',
    command: 'pnpm',
    args: ['check:i18n'],
  },
];

function createCommandRunner(cwd = process.cwd()) {
  return async ({ command, args }) => {
    const { stdout, stderr } = await execFile(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    return { stdout, stderr, exitCode: 0 };
  };
}

function summarizeCounts(checks) {
  const counts = checks.reduce((accumulator, check) => {
    accumulator[check.status] = (accumulator[check.status] ?? 0) + 1;
    return accumulator;
  }, {});

  return ['passed', 'failed', 'error', 'not-run']
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(', ');
}

function determineOverallStatus(checks) {
  if (checks.some((check) => check.status === 'error')) {
    return 'error';
  }

  if (checks.some((check) => check.status === 'failed')) {
    return 'failed';
  }

  if (checks.every((check) => check.status === 'not-run')) {
    return 'not-run';
  }

  return 'passed';
}

function normalizeSuccessResult(result) {
  if (typeof result === 'string') {
    return {
      stdout: result,
      stderr: '',
      exitCode: 0,
    };
  }

  return {
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 0,
  };
}

function normalizeFailureResult(error, label) {
  const exitCode = typeof error?.code === 'number' ? error.code : null;
  const status = exitCode === null ? 'error' : 'failed';
  const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
  const stderr = typeof error?.stderr === 'string'
    ? error.stderr
    : (typeof error?.message === 'string' ? `${error.message}\n` : '');
  const summary = status === 'failed'
    ? `${label} failed with exit code ${exitCode}.`
    : `${label} encountered an unexpected error.`;

  return {
    stdout,
    stderr,
    exitCode,
    status,
    summary,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

function createCheckResult(check, result) {
  return {
    key: check.key,
    label: check.label,
    command: check.command,
    args: [...check.args],
    ...result,
  };
}

export async function writeValidationArtifact(artifactPath, summary) {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

function buildSummary({ checks, logPath, reason }) {
  const [uiTypecheck, serverTypecheck, checkI18n] = checks;
  const status = determineOverallStatus(checks);

  return {
    status,
    summary: summarizeCounts(checks),
    reason,
    uiTypecheck,
    serverTypecheck,
    checkI18n,
    checks,
    logPath,
  };
}

export function createSkippedValidationSummary(reason, artifactPath = VALIDATION_LOG_PATH) {
  const checks = VALIDATION_CHECKS.map((check) => createCheckResult(check, {
    status: 'not-run',
    stdout: '',
    stderr: '',
    exitCode: null,
    summary: `Skipped because ${reason}.`,
  }));

  return buildSummary({
    checks,
    logPath: artifactPath,
    reason,
  });
}

export async function runValidationSuite({
  runCommand = createCommandRunner(),
  artifactPath = VALIDATION_LOG_PATH,
} = {}) {
  const checks = [];

  for (const check of VALIDATION_CHECKS) {
    try {
      const result = normalizeSuccessResult(await runCommand({
        command: check.command,
        args: check.args,
      }));

      checks.push(createCheckResult(check, {
        status: result.exitCode === 0 ? 'passed' : 'failed',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        summary: result.exitCode === 0
          ? `${check.label} passed.`
          : `${check.label} failed with exit code ${result.exitCode}.`,
      }));
    } catch (error) {
      checks.push(createCheckResult(check, normalizeFailureResult(error, check.label)));
    }
  }

  const summary = buildSummary({
    checks,
    logPath: artifactPath,
  });

  await writeValidationArtifact(artifactPath, summary);

  return summary;
}
