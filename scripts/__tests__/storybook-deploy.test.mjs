import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import authorize from "../../.github/scripts/authorize-storybook-deploy.cjs";

const ownerFile = ".github/** @cryppadotta @devinfoley @nickyleach @forgottendev\n";
function fixture(overrides = {}) {
  const calls = [];
  const context = {
    repo: { owner: "paperclipai", repo: "paperclip" },
    eventName: "workflow_dispatch",
    ref: "refs/heads/codex/example",
    actor: "cryppadotta",
    ...overrides.context,
  };
  const environment = {
    can_admins_bypass: false,
    protection_rules: [{
      type: "required_reviewers",
      reviewers: [{ type: "User", reviewer: { login: "cryppadotta" } }],
    }],
    ...overrides.environment,
  };
  const github = { rest: { repos: {
    get: async () => ({ data: { default_branch: "master" } }),
    getContent: async (params) => {
      calls.push(params);
      if (overrides.apiError) throw new Error("GitHub unavailable");
      return { data: { encoding: "base64", content: Buffer.from(overrides.codeowners ?? ownerFile).toString("base64") } };
    },
    getEnvironment: async () => ({ data: environment }),
  } } };
  return { github, context, calls };
}

// Tests are serial because the Actions rerunner is an environment variable.
process.env.GITHUB_TRIGGERING_ACTOR = "cryppadotta";
test("allows each current CODEOWNER on a feature branch; reads policy from master", async () => {
  for (const actor of ["cryppadotta", "devinfoley", "nickyleach", "forgottendev"]) {
    const f = fixture({ context: { actor } });
    await authorize(f);
    assert.equal(f.calls[0].ref, "master");
    assert.equal(f.calls[0].path, ".github/CODEOWNERS");
  }
});
test("rejects non-owner initiators", async () => {
  await assert.rejects(authorize(fixture({ context: { actor: "contributor" } })), /Only default-branch CODEOWNERS/);
});
test("rejects non-owner and missing rerunners, including deployment-only reruns", async () => {
  for (const actor of ["contributor", ""]) {
    process.env.GITHUB_TRIGGERING_ACTOR = actor;
    await assert.rejects(authorize(fixture()), /Only default-branch CODEOWNERS/);
  }
  process.env.GITHUB_TRIGGERING_ACTOR = "cryppadotta";
});
test("comments, teams, emails and partial account matches do not grant access", async () => {
  for (const codeowners of [
    "# @cryppadotta\n.github/** @other",
    ".github/** @other # @cryppadotta",
    ".github/** @paperclipai/cryppadotta",
    ".github/** cryppadotta@example.com",
    ".github/** @cryppadotta-extra",
    "",
  ]) await assert.rejects(authorize(fixture({ codeowners })), /CODEOWNERS/);
});
test("case-insensitive GitHub login matching", async () => {
  await authorize(fixture({ context: { actor: "CryppaDotta" } }));
});
test("rejects forks, PR events, automatic events and tags", async () => {
  for (const context of [
    { repo: { owner: "outsider", repo: "paperclip" } },
    { eventName: "pull_request" }, { eventName: "push" },
    { eventName: "workflow_call" }, { ref: "refs/tags/release" },
  ]) await assert.rejects(authorize(fixture({ context })));
});
test("fails closed when GitHub cannot return authoritative CODEOWNERS", async () => {
  await assert.rejects(authorize(fixture({ apiError: true })), /GitHub unavailable/);
});
test("requires CODEOWNER environment reviewers with administrator bypass disabled", async () => {
  for (const environment of [
    { can_admins_bypass: true },
    { protection_rules: [] },
    { protection_rules: [{ type: "required_reviewers", reviewers: [] }] },
    { protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "contributor" } }] }] },
    { protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "Team", reviewer: { login: "cryppadotta" } }] }] },
  ]) await assert.rejects(authorize(fixture({ environment })), /must require CODEOWNER reviewers/);
});
test("workflow keeps branch build read-only and reauthorizes the protected deploy", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/storybook-deploy.yml", import.meta.url), "utf8");
  const [build, deploy] = workflow.split("  build:")[1].split("  deploy:");
  assert.doesNotMatch(build, /pages: write|id-token: write|secrets\./);
  assert.match(build, /permissions: \{\}/);
  assert.doesNotMatch(build, /actions\/checkout|cache: pnpm/);
  assert.match(build, /package-manager-cache: false/);
  assert.match(build, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(deploy, /name: storybook-deploy/);
  assert.match(deploy, /authorize-storybook-deploy.cjs/);
  assert.match(deploy, /name: \$\{\{ needs.build.outputs.artifact_name \}\}/);
  assert.doesNotMatch(workflow.split("permissions:")[0], /push:|pull_request:/);
});

import { storybookDestination, branchIndex } from '../../.github/scripts/storybook-destination.cjs';
const input = { branch: 'feature/foo', sha: 'a'.repeat(40), runId: 123, runAttempt: 1,
  bucket: 'storybook-test', baseUrl: 'https://example.cloudfront.net' };
test('different branches have distinct stable URLs, including names that sanitize alike', () => {
  const branches = ['feature/foo', 'feature-foo', 'Feature/foo', 'master', 'feature_foo', 'a'.repeat(100), 'a'.repeat(101)];
  const urls = branches.map(branch => storybookDestination({ ...input, branch }).url);
  assert.equal(new Set(urls).size, branches.length);
  assert.ok(urls.every(url => /^https:\/\/example.cloudfront.net\/storybook\/branches\/[a-z0-9-]+\/index.html$/.test(url)));
});
test('redeploying a branch preserves its entry URL and creates a new build URL', () => {
  const a = storybookDestination(input);
  const b = storybookDestination({ ...input, sha: 'b'.repeat(40), runId: 124 });
  assert.equal(a.url, b.url);
  assert.notEqual(a.buildUrl, b.buildUrl);
  assert.notEqual(a.buildUrl, storybookDestination({ ...input, runAttempt: 2 }).buildUrl);
});
test('invalid source and destination inputs fail closed', () => {
  for (const change of [{ branch: '' }, { branch: 'a\nb' }, { sha: 'master' }, { runId: '../x' },
    { runAttempt: 0 }, { bucket: '../bucket' }, { baseUrl: 'http://example.com' },
    { baseUrl: 'https://user:password@example.com' }, { baseUrl: 'https://example.com/path' },
    { baseUrl: 'https://example.com?x=y' }]) {
    assert.throws(() => storybookDestination({ ...input, ...change }));
  }
});
test('branch entry preserves Storybook query and fragment deep links', () => {
  const html = branchIndex(storybookDestination(input).buildUrl);
  assert.match(html, /target.search = location.search/);
  assert.match(html, /target.hash = location.hash/);
  assert.match(html, /location.replace/);
});

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const publisher = fileURLToPath(new URL('../../.github/scripts/publish-storybook.cjs', import.meta.url));
function publishFixture(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'storybook-publish-test-'));
  mkdirSync(path.join(dir, 'storybook-static'));
  mkdirSync(path.join(dir, 'bin'));
  for (const name of ['index.html', 'iframe.html', 'index.json']) writeFileSync(path.join(dir, 'storybook-static', name), 'fixture');
  if (options.symlink) symlinkSync('/etc/passwd', path.join(dir, 'storybook-static', 'unsafe'));
  const stub = path.join(dir, 'bin', 'aws');
  writeFileSync(stub, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.UPLOAD_LOG,JSON.stringify(process.argv.slice(2))+'\\n');if(process.env.FAIL_UPLOAD==='1')process.exit(1);\n`);
  chmodSync(stub, 0o755);
  const result = spawnSync(process.execPath, [publisher], { cwd: dir, encoding: 'utf8', env: {
    ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: dir,
    SOURCE_BRANCH: input.branch, SOURCE_SHA: input.sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    STORYBOOK_S3_BUCKET: input.bucket, STORYBOOK_PUBLIC_BASE_URL: input.baseUrl,
    GITHUB_OUTPUT: path.join(dir, 'output'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    UPLOAD_LOG: path.join(dir, 'uploads'), FAIL_UPLOAD: options.fail ? '1' : '0',
  } });
  let uploads = [];
  try { uploads = readFileSync(path.join(dir, 'uploads'), 'utf8').trim().split('\n').map(JSON.parse); } catch {}
  let report = '';
  let summary = '';
  if (result.status === 0) {
    report = readFileSync(path.join(dir, 'storybook-deployment.md'), 'utf8');
    summary = readFileSync(path.join(dir, 'summary'), 'utf8');
  }
  rmSync(dir, { recursive: true, force: true });
  return { result, uploads, report, summary };
}
test('publisher uploads a complete build then updates only that branch entry', () => {
  const { result, uploads } = publishFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(uploads.length, 2);
  const d = storybookDestination(input);
  assert.ok(uploads[0].includes(`s3://${input.bucket}/${d.buildPrefix}/`));
  assert.ok(uploads[1].includes(`s3://${input.bucket}/${d.prefix}/index.html`));
  assert.ok(uploads[0].includes('--no-follow-symlinks'));
  assert.doesNotMatch(JSON.stringify(uploads), /--delete/);
});
test('a failed build upload never changes the stable branch entry', () => {
  const { result, uploads } = publishFixture({ fail: true });
  assert.notEqual(result.status, 0);
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].includes('--recursive'));
});
test('artifact symlinks fail before any upload', () => {
  const { result, uploads } = publishFixture({ symlink: true });
  assert.notEqual(result.status, 0);
  assert.equal(uploads.length, 0);
});

test('successful publication produces a downloadable Markdown report matching the run summary', () => {
  const { result, report, summary } = publishFixture();
  assert.equal(result.status, 0, result.stderr);
  const d = storybookDestination(input);
  assert.ok(report.includes(`[Branch Storybook](${d.url})`));
  assert.ok(report.includes(`[This build](${d.buildUrl})`));
  assert.ok(report.includes(d.sha));
  assert.equal(report, summary);
});

import { verifyStorybook } from '../../.github/scripts/verify-storybook.cjs';
test('public verification retries a stale stable branch entry until it points to the new build', async () => {
  const d = storybookDestination(input);
  let indexReads = 0;
  await verifyStorybook({ branchUrl: d.url, buildUrl: d.buildUrl, sha: d.sha,
    sleep: async () => {}, attempts: 2, fetch: async (url) => String(url).endsWith('deployment.json')
      ? new Response(JSON.stringify({ sha: d.sha }))
      : new Response(branchIndex(++indexReads === 1 ? d.buildUrl.replace('123-1', '122-1') : d.buildUrl)) });
  assert.equal(indexReads, 2);
});
test('public verification rejects a permanently stale branch URL or wrong source commit', async () => {
  const d = storybookDestination(input);
  for (const wrong of ['branch', 'sha']) {
    await assert.rejects(verifyStorybook({ branchUrl: d.url, buildUrl: d.buildUrl, sha: d.sha,
      attempts: 1, fetch: async (url) => String(url).endsWith('deployment.json')
        ? new Response(JSON.stringify({ sha: wrong === 'sha' ? 'b'.repeat(40) : d.sha }))
        : new Response(branchIndex(wrong === 'branch' ? d.buildUrl.replace('123-1', '122-1') : d.buildUrl)) }),
    wrong === 'branch' ? /does not point to this build/ : /wrong source commit/);
  }
});
