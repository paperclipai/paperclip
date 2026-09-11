const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { storybookDestination, branchIndex } = require('./storybook-destination.cjs');

const destination = storybookDestination({
  branch: process.env.SOURCE_BRANCH, sha: process.env.SOURCE_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  bucket: process.env.STORYBOOK_S3_BUCKET, baseUrl: process.env.STORYBOOK_PUBLIC_BASE_URL,
});
const source = path.resolve('storybook-static');
// Treat the artifact as public files, never as executable publisher code.
function validateTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`Unsupported artifact entry: ${path.join(dir, entry.name)}`);
    }
    if (entry.isDirectory()) validateTree(path.join(dir, entry.name));
  }
}
validateTree(source);
for (const name of ['index.html', 'iframe.html', 'index.json']) {
  if (!fs.statSync(path.join(source, name)).isFile() || fs.statSync(path.join(source, name)).size === 0) {
    throw new Error(`Missing Storybook output: ${name}`);
  }
}
fs.writeFileSync(path.join(source, 'deployment.json'), JSON.stringify(destination, null, 2) + '\n');
const aws = (args) => execFileSync('aws', args, { stdio: 'inherit' });
// Complete a unique build before changing the branch's entry point. No deletion
// permissions, shared root writes or mixed-version branch assets are needed.
aws(['s3', 'cp', source, `s3://${destination.bucket}/${destination.buildPrefix}/`,
  '--recursive', '--no-follow-symlinks', '--only-show-errors',
  '--cache-control', 'public,max-age=31536000,immutable']);
const indexFile = path.join(process.env.RUNNER_TEMP, 'storybook-branch-index.html');
fs.writeFileSync(indexFile, branchIndex(destination.buildUrl));
aws(['s3', 'cp', indexFile, `s3://${destination.bucket}/${destination.prefix}/index.html`,
  '--content-type', 'text/html; charset=utf-8', '--cache-control', 'no-cache,max-age=0,must-revalidate', '--only-show-errors']);
const report = `[Branch Storybook](${destination.url})\n\n[This build](${destination.buildUrl})\n\nCommit: \`${destination.sha}\`\n`;
const reportPath = path.join(process.env.RUNNER_TEMP, 'storybook-deployment.md');
fs.writeFileSync(reportPath, report);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
  `url=${destination.url}\nbuild_url=${destination.buildUrl}\nreport_path=${reportPath}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(JSON.stringify(destination));
