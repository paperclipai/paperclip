import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { catalogTargetSha, catalogManifestSha256, fullCatalogPlanName, fullCatalogCases, validateFullCatalogManifest } from './chat-full-catalog-testops-manifest.mjs';

const { parseDocument } = createRequire(import.meta.url)('yaml');
const bytes = readFileSync(new URL('./chat-full-catalog-testops-manifest.json', import.meta.url));
const manifest = JSON.parse(bytes);
const row = id => fullCatalogCases.find(value => value.key === id);

test('the manifest joins all244 source YAML scenarios without importing a domain or fabricating a result', () => {
  const directory = new URL('./chat-scenarios/', import.meta.url);
  const scenarios = readdirSync(directory).filter(file => file.endsWith('.yaml') && file !== 'defaults.yaml').flatMap(file => {
    const parsed = parseDocument(readFileSync(new URL(file, directory), 'utf8'), { uniqueKeys: true });
    assert.deepEqual(parsed.errors, []);
    return parsed.toJS().scenarios;
  });
  assert.equal(scenarios.length, 244);
  assert.equal(fullCatalogCases.length, 244);
  assert.deepEqual(fullCatalogCases.map(value => value.key).sort(), scenarios.map(value => value.id).sort());
  for (const scenario of scenarios) {
    const actual = row(scenario.id);
    assert.equal(actual.originalQuery, scenario.query);
    assert.equal(actual.originalContext, scenario.context);
    assert.equal(actual.expectedOutcome, scenario.expected_outcome);
    assert.ok(!Object.hasOwn(actual, 'status') && !Object.hasOwn(actual, 'passed'));
  }
});

test('legacy aliases preserve existing TestOps identities while execution uses actual legacy task IDs', () => {
  for (const task of ['create-backlog', 'delegate-announcement']) {
    const actual = row(`tasks.${task}`);
    assert.equal(actual.scenario, task);
    assert.equal(actual.executionId, `chat-features.runner-opencode.local.${task}`);
    assert.equal(actual.fullName, `paperclip.Product E2E.chat-features.tasks.${task}`);
    assert.deepEqual(actual.aliases, [`paperclip.Product E2E.chat-features.${task}`]);
  }
});

test('source bounds retain legacy and pilot runs, native zero turn policy and original finite attempts', () => {
  for (const [id, minimum, maximum, attempt, checks] of [
    ['tasks.create-backlog', 1, 1, 420000, 10], ['tasks.delegate-announcement', 3, 3, 420000, 15],
    ['instance-operations.restart-service', 1, 1, 420000, 9], ['projects.project-defaults', 3, 3, 660000, 11],
    ['projects.project-work', 1, 3, 300000, 15],
  ]) {
    const actual = row(id);
    assert.deepEqual([actual.minimumRuns, actual.maximumRuns, actual.attemptTimeoutMs, actual.checks], [minimum, maximum, attempt, checks]);
    assert.equal(actual.turnTimeoutMs, id.startsWith('tasks.') ? 120000 : 0);
  }
  assert.equal(row('access.sign-in').maximumRuns, 0);
  assert.equal(row('assistant-connections.use-scoped-client').maximumRuns, 0);
  assert.equal(fullCatalogCases.filter(value => value.turnTimeoutMs === 0).length, 242);
});

test('definition gaps and private prerequisites remain explicit instead of inferred runnable passes', () => {
  assert.deepEqual(fullCatalogCases.filter(value => value.coverageGaps.length).map(value => value.key), [
    'access.invite-teammate', 'access.manage-membership', 'activity.routine-audit', 'agents.restore-instructions', 'budgets-costs.subscription-fees',
  ]);
  assert.equal(fullCatalogCases.filter(value => value.requiredCredentials.length).length, 18);
  assert.equal(fullCatalogCases.filter(value => value.externalInput !== null).length, 37);
  assert.equal(row('skills.enable-for-agent').coverageGaps.length, 0);
});

test('surface evidence declarations never manufacture a generic final screenshot for boundary cases', () => {
  assert.equal(row('agent-chat.chat-disabled').screenshot, 'runtime-disabled-agent-chat.png');
  for (const id of ['access.sign-in', 'onboarding.choose-first-runtime', 'onboarding.new-instance', 'onboarding.resume-wizard', 'assistant-connections.use-scoped-client']) {
    assert.equal(row(id).screenshot, null);
    assert.match(row(id).evidenceReadiness, /requires-final-state\.png/);
  }
  assert.equal(row('projects.project-work').screenshot, 'final-state.png');
  assert.ok(manifest.source.requiredOriginalPassEvidence.includes('final-state.png'));
});

test('source identities and descriptor provenance are stable, deeply frozen and deterministic', () => {
  assert.equal(catalogTargetSha, manifest.targetSha);
  assert.equal(catalogManifestSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fullCatalogPlanName, 'Chat feature catalog — OpenCode 1017 (candidate)');
  assert.equal(new Set(fullCatalogCases.map(value => value.fullName)).size, 244);
  assert.equal(manifest.source.scenarioFiles.length, 35);
  assert.equal(manifest.metadataSourceSha, 'de0941835cc8f0d01c982574ee258e110babdbeb');
  assert.throws(() => { fullCatalogCases[0].coverageGaps.push('changed'); }, TypeError);
  assert.throws(() => { fullCatalogCases[0].maximumRuns = 999; }, TypeError);
  assert.ok(!bytes.toString().match(/sk-or-v1-[a-f0-9]{32,}/));
});

test('foreign identity, duplicated case and changed run-bound metadata are rejected by the pure loader', () => {
  const copy = () => structuredClone(manifest);
  const foreign = copy(); foreign.cases[0].executionId = 'chat-features.other.local.case';
  assert.throws(() => validateFullCatalogManifest(foreign), /row_invalid/);
  const duplicate = copy(); duplicate.cases[1] = duplicate.cases[0];
  assert.throws(() => validateFullCatalogManifest(duplicate), /identity_conflict/);
  const bounds = copy(); bounds.cases[0].minimumRuns = bounds.cases[0].maximumRuns + 1;
  assert.throws(() => validateFullCatalogManifest(bounds), /row_invalid/);
});
