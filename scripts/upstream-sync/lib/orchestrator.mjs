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
import { renderPrBody } from './pr-body.mjs';
import { scanAndMaybeTranslateLowRisk } from './translate-low-risk.mjs';
import {
  createValidationErrorSummary,
  createSkippedValidationSummary,
  runValidationSuite,
  VALIDATION_LOG_PATH,
  writeValidationArtifact,
} from './validation.mjs';

const execFile = promisify(execFileCallback);
const REPORT_PATH = 'reports/upstream-sync-report.json';
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

function createSkippedLocalizationSummary(reason) {
  return {
    localizationSummary: {
      lowRiskFiles: [],
      markdownPairs: [],
      manualReviewItems: [],
      skippedReason: reason,
    },
    translationSummary: {
      enabled: false,
      mode: 'review-only',
      reason,
      translatedFiles: [],
      translatedEntryCount: 0,
      translatedEntries: [],
    },
  };
}

function buildReport({
  config,
  branchName,
  status,
  commits,
  diagnostics,
  localizationResult,
  validationSummary,
  readyForPr,
  validationLogPath,
}) {
  return {
    branchName,
    status,
    commits,
    dryRun: config.dryRun,
    readyForPr,
    upstreamRef: config.upstreamRef,
    maintenanceRef: config.maintenanceRef,
    conflictDiagnostics: diagnostics ?? null,
    localizationSummary: localizationResult.localizationSummary,
    translationSummary: localizationResult.translationSummary,
    validationSummary,
    validationLogPath,
  };
}

async function resolveValidationSummary({ config, runValidation, status }) {
  if (status === 'conflict') {
    const summary = createSkippedValidationSummary('replay-conflict', VALIDATION_LOG_PATH);
    await writeValidationArtifact(VALIDATION_LOG_PATH, summary);
    return summary;
  }

  if (config.dryRun) {
    const summary = createSkippedValidationSummary('dry-run', VALIDATION_LOG_PATH);
    await writeValidationArtifact(VALIDATION_LOG_PATH, summary);
    return summary;
  }

  try {
    return await runValidation({ artifactPath: VALIDATION_LOG_PATH });
  } catch (error) {
    const summary = createValidationErrorSummary(error, VALIDATION_LOG_PATH);
    await writeValidationArtifact(VALIDATION_LOG_PATH, summary);
    return summary;
  }
}

export async function runUpstreamSync({
  config,
  run = createGitRunner(),
  scanLocalization = scanAndMaybeTranslateLowRisk,
  runValidation = runValidationSuite,
  renderPrBodyContent = renderPrBody,
} = {}) {
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

  const localizationResult = status === 'conflict'
    ? createSkippedLocalizationSummary('replay-conflict')
    : await scanLocalization({ config, run });
  const validationSummary = await resolveValidationSummary({
    config,
    runValidation,
    status,
  });
  const validationStatus = validationSummary.status;
  const validationLogPath = validationSummary.logPath ?? '';
  const readyForPr = !config.dryRun && status !== 'conflict' && validationStatus === 'passed';

  const report = buildReport({
    config,
    branchName,
    status,
    commits,
    diagnostics,
    localizationResult,
    validationSummary,
    readyForPr,
    validationLogPath,
  });

  const reportPath = REPORT_PATH;
  const prBodyPath = PR_BODY_PATH;

  await writeArtifact(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeArtifact(prBodyPath, renderPrBodyContent(report));

  return {
    branchName,
    commits,
    reportPath,
    prBodyPath,
    status,
    validationStatus,
    validationLogPath,
    readyForPr,
    diagnostics,
    report,
  };
}
