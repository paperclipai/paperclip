import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import {
  captureConflictDiagnostics,
  listMaintenanceCommits,
  listUnmergedFiles,
  prepareBotBranch,
  replayCommitStack,
} from './git-ops.mjs';

const execFile = promisify(execFileCallback);
const REPORT_PATH = 'reports/upstream-sync-report.md';
const PR_BODY_PATH = 'reports/upstream-sync-pr-body.md';

function createGitRunner(cwd = process.cwd()) {
  return async ({ command, args }) => {
    if (command !== 'git') {
      throw new Error(`Unsupported command: ${command}`);
    }

    const { stdout } = await execFile(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    return stdout;
  };
}

async function runGit(run, args) {
  const result = await run({ command: 'git', args });
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result.stdout === 'string') {
    return result.stdout;
  }
  return '';
}

async function writeArtifact(artifactPath, contents) {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, contents, 'utf8');
}

async function resolveBotBranchName({ run, branchPrefix, upstreamRef }) {
  const shortSha = (await runGit(run, ['rev-parse', '--short=12', upstreamRef])).trim();
  return `${branchPrefix}/${shortSha}`;
}

function buildReportContent({ config, branchName, status, commits, diagnostics }) {
  return [
    '# Upstream sync report',
    '',
    `- status: \`${status}\``,
    `- branch: \`${branchName}\``,
    `- upstream ref: \`${config.upstreamRef}\``,
    `- maintenance ref: \`${config.maintenanceRef}\``,
    '',
    '## Maintenance commits',
    ...commits.map((commit) => `- \`${commit}\``),
    '',
    diagnostics?.conflicts?.length
      ? [
          '## Conflict diagnostics',
          `- failing commit: \`${diagnostics.failingCommit}\``,
          '### Current git status',
          '```',
          diagnostics.status,
          '```',
          '',
          '### Failing commit summary',
          '```',
          diagnostics.failingCommitSummary,
          '```',
          '',
          ...diagnostics.conflicts.map((file) => `- \`${file}\``),
          '',
        ]
      : [],
  ]
    .flat()
    .join('\n');
}

function buildPrBodyContent({ config, branchName, status, commits }) {
  return [
    '# Upstream sync',
    '',
    `- status: \`${status}\``,
    `- branch: \`${branchName}\``,
    `- upstream ref: \`${config.upstreamRef}\``,
    `- maintenance ref: \`${config.maintenanceRef}\``,
    '',
    '## Replayed commits',
    ...commits.map((commit) => `- \`${commit}\``),
    '',
  ].join('\n');
}

export async function runUpstreamSync({ config, run = createGitRunner() }) {
  const commits = await listMaintenanceCommits({
    run,
    upstreamRef: config.upstreamRef,
    maintenanceRef: config.maintenanceRef,
  });
  const branchName = await resolveBotBranchName({
    run,
    branchPrefix: config.branchPrefix,
    upstreamRef: config.upstreamRef,
  });

  let status = 'dry-run';
  let diagnostics;

  if (!config.dryRun) {
    await prepareBotBranch({
      run,
      baseRef: config.upstreamRef,
      branchName,
    });

    try {
      await replayCommitStack({ run, commits });
      status = 'replayed';
    } catch (error) {
      let conflicts;
      try {
        conflicts = await listUnmergedFiles({ run });
      } catch {
        throw error;
      }

      if (conflicts.length === 0) {
        throw error;
      }

      status = 'conflict';
      diagnostics = await captureConflictDiagnostics({
        run,
        failingCommit: error && typeof error === 'object' && 'failingCommit' in error ? error.failingCommit : commits[commits.length - 1],
        conflicts,
      });
    }
  }

  const reportPath = REPORT_PATH;
  const prBodyPath = PR_BODY_PATH;

  await writeArtifact(reportPath, buildReportContent({ config, branchName, status, commits, diagnostics }));
  await writeArtifact(prBodyPath, buildPrBodyContent({ config, branchName, status, commits }));

  return {
    branchName,
    commits,
    reportPath,
    prBodyPath,
    status,
    diagnostics,
  };
}
