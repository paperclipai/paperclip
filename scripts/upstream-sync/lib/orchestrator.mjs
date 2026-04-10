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
  failure = null,
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
    failure,
  };
}

function buildFailure(stage, error) {
  return {
    stage,
    message: error instanceof Error ? error.message : String(error),
  };
}

function renderFallbackPrBody(report, error) {
  const failure = report.failure ?? buildFailure('render-pr-body', error);
  return [
    '# Upstream sync',
    '',
    `- replay status: \`${report.status}\``,
    `- branch: \`${report.branchName ?? ''}\``,
    `- upstream ref/tag: \`${report.upstreamRef}\``,
    `- maintenance ref: \`${report.maintenanceRef}\``,
    '',
    '## Failure',
    `- stage: \`${failure.stage}\``,
    `- message: ${failure.message}`,
    '',
  ].join('\n');
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
  const reportPath = REPORT_PATH;
  const prBodyPath = PR_BODY_PATH;
  let stage = 'list-maintenance-commits';
  let commits = [];
  let branchName = '';
  let status = config.dryRun ? 'dry-run' : 'preparing';
  let diagnostics;
  let localizationResult = createSkippedLocalizationSummary('not-started');
  let validationSummary;
  let validationStatus = 'not-run';
  let validationLogPath = '';
  let readyForPr = false;

  try {
    commits = await listMaintenanceCommits({
      run,
      upstreamRef: config.upstreamRef,
      maintenanceRef: config.maintenanceRef,
    });
    stage = 'resolve-bot-branch-name';
    branchName = await resolveBotBranchName({
      run,
      branchPrefix: config.branchPrefix,
      upstreamRef: config.upstreamRef,
    });

    if (commits.length === 0) {
      status = 'no-op';
      localizationResult = createSkippedLocalizationSummary('no-commits');
      validationSummary = createSkippedValidationSummary('no-commits', VALIDATION_LOG_PATH);
      await writeValidationArtifact(VALIDATION_LOG_PATH, validationSummary);
      validationStatus = validationSummary.status;
      validationLogPath = validationSummary.logPath ?? '';

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

      stage = 'write-report-artifact';
      await writeArtifact(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      stage = 'render-pr-body';
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

    if (!config.dryRun) {
      stage = 'prepare-bot-branch';
      await prepareBotBranch({
        run,
        baseRef: config.upstreamRef,
        branchName,
      });

      try {
        stage = 'replay-commit-stack';
        await replayCommitStack({ run, commits });
        status = 'replayed';
      } catch (error) {
        let conflicts;
        stage = 'detect-conflicts';
        try {
          conflicts = await listUnmergedFiles({ run });
        } catch {
          throw error;
        }

        if (conflicts.length === 0) {
          throw error;
        }

        stage = 'capture-conflict-diagnostics';
        status = 'conflict';
        diagnostics = await captureConflictDiagnostics({
          run,
          failingCommit: error && typeof error === 'object' && 'failingCommit' in error ? error.failingCommit : commits[commits.length - 1],
          conflicts,
        });
      }
    }
    stage = 'scan-localization';
    localizationResult = status === 'conflict'
      ? createSkippedLocalizationSummary('replay-conflict')
      : await scanLocalization({ config, run });

    stage = 'resolve-validation-summary';
    validationSummary = await resolveValidationSummary({
      config,
      runValidation,
      status,
    });
    validationStatus = validationSummary.status;
    validationLogPath = validationSummary.logPath ?? '';
    readyForPr = !config.dryRun && status !== 'conflict' && validationStatus === 'passed';

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

    stage = 'write-report-artifact';
    await writeArtifact(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    stage = 'render-pr-body';
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
  } catch (error) {
    if (!validationSummary) {
      validationSummary = createSkippedValidationSummary(`orchestration-failed:${stage}`, VALIDATION_LOG_PATH);
      await writeValidationArtifact(VALIDATION_LOG_PATH, validationSummary);
      validationStatus = validationSummary.status;
      validationLogPath = validationSummary.logPath ?? '';
    }

    if (!localizationResult || localizationResult.localizationSummary?.skippedReason === 'not-started') {
      localizationResult = createSkippedLocalizationSummary(`orchestration-failed:${stage}`);
    }

    status = 'error';
    readyForPr = false;

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
      failure: buildFailure(stage, error),
    });

    stage = 'write-report-artifact';
    await writeArtifact(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    stage = 'render-pr-body';
    let prBody;
    try {
      prBody = renderPrBodyContent(report);
    } catch (renderError) {
      prBody = renderFallbackPrBody(report, renderError);
    }
    await writeArtifact(prBodyPath, prBody);

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
      error: report.failure,
    };
  }
}
