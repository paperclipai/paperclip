import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPORT_PATH = 'reports/upstream-sync-report.md';
const PR_BODY_PATH = 'reports/upstream-sync-pr-body.md';

async function writeBootstrapArtifact(artifactPath, contents) {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, contents, 'utf8');
}

function buildReportContent({ config, branchName, status }) {
  return [
    '# Upstream sync bootstrap',
    '',
    'This is a Task 1 bootstrap artifact.',
    `- branch: \`${branchName}\``,
    `- repo: \`${config.githubRepository}\``,
    `- base branch: \`${config.baseBranch}\``,
    `- status: \`${status}\``,
    '',
    'Later tasks will replace this placeholder with a real sync report.',
    '',
  ].join('\n');
}

function buildPrBodyContent({ config, branchName, status }) {
  return [
    '# Bootstrap upstream sync',
    '',
    'This PR body is a bootstrap placeholder.',
    `- branch: \`${branchName}\``,
    `- repo: \`${config.githubRepository}\``,
    `- status: \`${status}\``,
    '',
    'Later tasks will replace this with the final PR description.',
    '',
  ].join('\n');
}

export async function runUpstreamSync({ config }) {
  const branchName = `${config.branchPrefix}/sync`;
  const status = config.dryRun ? 'bootstrap-dry-run' : 'bootstrap-not-ready';
  const reportPath = REPORT_PATH;
  const prBodyPath = PR_BODY_PATH;

  await writeBootstrapArtifact(reportPath, buildReportContent({ config, branchName, status }));
  await writeBootstrapArtifact(prBodyPath, buildPrBodyContent({ config, branchName, status }));

  return {
    branchName,
    reportPath,
    prBodyPath,
    status,
  };
}
