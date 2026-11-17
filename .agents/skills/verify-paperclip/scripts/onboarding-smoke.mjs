#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(path.join(repo, 'package.json'));
const { chromium, expect } = require('@playwright/test');
assert.equal(process.argv[2], '--evidence-dir', 'Usage: onboarding-smoke.mjs --evidence-dir <path>');
assert.ok(process.argv[3]);
const evidence = path.resolve(process.argv[3]);
execFileSync('python3', [path.join(repo, '.agents/skills/verify-paperclip/scripts/doctor.py'), '--evidence-dir', evidence], { stdio: 'inherit' });
const launch = JSON.parse(await fs.readFile(path.join(evidence, 'launch.json'), 'utf8'));
assert.equal(new URL(launch.url).hostname, '127.0.0.1');
const browser = await chromium.launch({ headless: true, ...(process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL ? { channel: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const companyName = `Verification ${Date.now()}`;
const result = { feature: 'onboarding.md', subFeatures: ['company', 'resume'], entryPoint: 'web-wizard', commit: launch.commit, url: launch.url, actor: 'local_trusted board', providerCalls: false, mockedResponses: false, companyName, status: 'failed' };
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
async function capture(name) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
  await fs.writeFile(path.join(evidence, `${name}.txt`), await page.locator('body').innerText());
}
try {
  const before = await page.request.get(`${launch.url}/api/companies`);
  assert.equal(before.ok(), true);
  assert.deepEqual(await before.json(), [], 'Smoke requires a fresh instance.');
  await page.goto(`${launch.url}/onboarding`);
  const start = page.getByRole('button', { name: /Start Onboarding|New Organization|Add Agent/ });
  if (await start.count()) await start.first().click();
  const create = page.getByRole('button', { name: /Build a new organization/ });
  if (await create.count()) await create.first().click();
  await expect(page.getByRole('heading', { name: 'What is the name of your organization?' })).toBeVisible({ timeout: 60_000 });
  await page.getByPlaceholder('e.g. Northwind Labs').fill(companyName);
  await capture('before-create');
  await page.getByRole('button', { name: /^Continue/ }).click();
  await expect(page.locator('#onboarding-agent-name')).toBeVisible({ timeout: 30_000 });
  await capture('after-create');
  const companiesResponse = await page.request.get(`${launch.url}/api/companies`);
  assert.equal(companiesResponse.ok(), true);
  const companies = await companiesResponse.json();
  const company = companies.find(item => item.name === companyName);
  assert.ok(company, 'UI-created company must be persisted.');
  result.companyId = company.id;
  const goalsResponse = await page.request.get(`${launch.url}/api/companies/${company.id}/goals`);
  assert.equal(goalsResponse.ok(), true);
  assert.deepEqual(await goalsResponse.json(), [], 'Naming must not invent a mission.');
  await page.goto(`${launch.url}/${company.issuePrefix}/onboarding`);
  await expect(page.locator('#onboarding-agent-name')).toBeVisible({ timeout: 30_000 });
  await capture('after-reopen');
  await page.reload();
  await expect(page.locator('#onboarding-agent-name')).toBeVisible({ timeout: 30_000 });
  await capture('after-reload');
  const persistedResponse = await page.request.get(`${launch.url}/api/companies`);
  assert.equal(persistedResponse.ok(), true);
  const persisted = await persistedResponse.json();
  assert.equal(persisted.length, 1, 'Resume must not create another company.');
  assert.equal(persisted[0].id, company.id);
  assert.deepEqual(errors, [], 'No browser exceptions.');
  result.status = 'passed';
  result.observed = 'Company persisted; onboarding resumed at the agent step after reload; no mission invented.';
  result.notRun = ['agent hiring', 'first task/model execution', 'cli-setup entry point'];
} catch (error) {
  result.error = error.message;
  await capture('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  result.browserErrors = errors;
  await context.tracing.stop({ path: path.join(evidence, 'trace.zip') });
  await browser.close();
  await fs.writeFile(path.join(evidence, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}
