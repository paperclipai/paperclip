const { createHash } = require('node:crypto');

function storybookDestination({ branch, sha, runId, runAttempt, bucket, baseUrl }) {
  if (typeof branch !== 'string' || !branch || /[\x00-\x20\x7f]/.test(branch)) {
    throw new Error('A non-empty repository branch name is required.');
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A full source commit SHA is required.');
  if (![runId, runAttempt].every((value) => /^[1-9]\d*$/.test(String(value)))) {
    throw new Error('A valid workflow run and attempt are required.');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid Storybook S3 bucket.');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Storybook base URL must be a credential-free HTTPS origin.');
  }
  const label = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,60) || 'branch';
  const digest = createHash('sha256').update(branch).digest('hex').slice(0,16);
  const branchKey = `${label}-${digest}`;
  const prefix = `storybook/branches/${branchKey}`;
  const buildPrefix = `${prefix}/builds/${runId}-${runAttempt}`;
  return {
    branch, sha, bucket, branchKey, prefix, buildPrefix,
    url: `${base.origin}/${prefix}/index.html`,
    buildUrl: `${base.origin}/${buildPrefix}/index.html`,
  };
}

function branchIndex(buildUrl) {
  // The target is generated from a validated origin and ASCII path segments.
  const target = JSON.stringify(buildUrl).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Storybook preview</title>
<script>const target = new URL(${target}); target.search = location.search; target.hash = location.hash; location.replace(target.href);</script>
<noscript><a href="${buildUrl}">Open this branch's Storybook</a></noscript></html>\n`;
}
module.exports = { storybookDestination, branchIndex };
