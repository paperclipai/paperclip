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
    const override = field => manifest.source.repairMetadata.changedFields.find(change => change.key === scenario.id && change.field === field);
    for (const [field, original] of [['originalQuery', scenario.query], ['originalContext', scenario.context], ['expectedOutcome', scenario.expected_outcome]]) {
      const change = override(field);
      if (change) { assert.equal(change.previous, original); assert.equal(actual[field], change.current); }
      else assert.equal(actual[field], original);
    }
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


test('repair source metadata binds the corrected candidate and explicit changed definitions', () => {
  const repair = manifest.source.repairMetadata;
  assert.equal(repair.baseTargetSha, '3b66c3c144360ddf32714a0742fd774b8ceafb16');
  assert.equal(repair.previousTargetSha, 'ab2019e976076ec0eb60b026844f3d9211cb0208');
  assert.equal(manifest.targetSha, '4a2c0e5dd9e66cb4dfdff06a5a66338bec5efa76');
  assert.equal(repair.definitionSourceSha, manifest.metadataSourceSha);
  assert.equal(repair.candidateDescriptorSnapshot, 'fixtures/chat-repair-candidate-descriptors.json');
  const descriptorBytes = readFileSync(new URL(repair.candidateDescriptorSnapshot, import.meta.url));
  assert.equal(createHash('sha256').update(descriptorBytes).digest('hex'), repair.candidateDescriptorSha256);
  const declarations = JSON.parse(descriptorBytes);
  assert.equal(declarations.length, 242);
  assert.equal(new Set(declarations.map(value => value.scenarioId)).size, 242);
  assert.deepEqual(repair.changedFields.map(value => [value.key, value.field]), [
  [
    "activity.work-timeline",
    "sourceFiles"
  ],
  [
    "activity.work-timeline",
    "oracleVersion"
  ],
  [
    "activity.work-timeline",
    "expectedOutcome"
  ],
  [
    "agents.choose-primary",
    "sourceFiles"
  ],
  [
    "app-permissions.ask-before-action",
    "sourceFiles"
  ],
  [
    "app-permissions.ask-before-action",
    "oracleVersion"
  ],
  [
    "app-permissions.test-as-agent",
    "sourceFiles"
  ],
  [
    "app-permissions.test-as-agent",
    "oracleVersion"
  ],
  [
    "app-permissions.test-as-agent",
    "originalContext"
  ],
  [
    "app-permissions.test-as-agent",
    "expectedOutcome"
  ],
  [
    "cli-operations.choose-cli-context",
    "sourceFiles"
  ],
  [
    "cli-operations.choose-cli-context",
    "oracleVersion"
  ],
  [
    "companies.agent-observability",
    "sourceFiles"
  ],
  [
    "companies.configure-decision-model",
    "sourceFiles"
  ],
  [
    "companies.fast-responses",
    "sourceFiles"
  ],
  [
    "companies.fast-responses",
    "originalQuery"
  ],
  [
    "companies.prompt-injection-guard",
    "sourceFiles"
  ],
  [
    "goals.create-goal-tree",
    "oracleVersion"
  ],
  [
    "goals.create-goal-tree",
    "expectedOutcome"
  ],
  [
    "navigation-preferences.dismiss-announcement",
    "sourceFiles"
  ],
  [
    "navigation-preferences.dismiss-announcement",
    "oracleVersion"
  ],
  [
    "questions-and-approvals.duplicate-answer",
    "oracleVersion"
  ],
  [
    "questions-and-approvals.formal-hire-revision",
    "sourceFiles"
  ],
  [
    "questions-and-approvals.formal-hire-revision",
    "oracleVersion"
  ],
  [
    "questions-and-approvals.multi-part-question",
    "oracleVersion"
  ],
  [
    "questions-and-approvals.reject-and-revise",
    "sourceFiles"
  ],
  [
    "questions-and-approvals.reject-and-revise",
    "oracleVersion"
  ],
  [
    "questions-and-approvals.review-plan",
    "sourceFiles"
  ],
  [
    "questions-and-approvals.review-plan",
    "oracleVersion"
  ],
  [
    "secrets.configure-company-secret",
    "sourceFiles"
  ],
  [
    "secrets.configure-company-secret",
    "oracleVersion"
  ],
  [
    "secrets.personal-secret",
    "sourceFiles"
  ],
  [
    "secrets.personal-secret",
    "oracleVersion"
  ],
  [
    "skills.author-skill",
    "sourceFiles"
  ],
  [
    "skills.author-skill",
    "oracleVersion"
  ],
  [
    "skills.author-skill",
    "expectedOutcome"
  ],
  [
    "skills.enable-for-agent",
    "sourceFiles"
  ],
  [
    "skills.explicit-restriction",
    "sourceFiles"
  ],
  [
    "skills.find-and-install",
    "sourceFiles"
  ],
  [
    "skills.fork-read-only",
    "sourceFiles"
  ],
  [
    "skills.review-update",
    "sourceFiles"
  ],
  [
    "skills.studio-test",
    "sourceFiles"
  ],
  [
    "skills.studio-test",
    "oracleVersion"
  ],
  [
    "skills.studio-test",
    "maximumRuns"
  ],
  [
    "teams.configure-team",
    "sourceFiles"
  ],
  [
    "teams.configure-team",
    "oracleVersion"
  ]
]);
  for (const change of repair.changedFields) {
    assert.deepEqual(row(change.key)[change.field], change.current);
    assert.notDeepEqual(change.current, change.previous);
  }
  assert.equal(repair.descriptorChanges.length, 44);
  assert.equal(new Set(repair.descriptorChanges.map(change => change.key)).size, 28);
  assert.deepEqual([...new Set(repair.descriptorChanges.map(change => change.field))].sort(), ['expectedRunCount', 'minimumRunCount', 'oracleVersion', 'setupPolicy', 'sourceFiles']);
  for (const change of repair.descriptorChanges) {
    assert.notDeepEqual(change.current, change.previous);
    const declaration = declarations.find(value => value.scenarioId === change.key);
    assert.ok(declaration);
    assert.deepEqual(change.current, declaration[change.field]);
    if (Object.hasOwn(row(change.key), change.field)) assert.deepEqual(row(change.key)[change.field], change.current);
  }
  assert.deepEqual(repair.changedDefinitionFiles.map(value => value.path), [
    'tests/runner-e2e/chat-scenarios/companies.yaml', 'tests/runner-e2e/chat-scenarios/goals.yaml', 'tests/runner-e2e/chat-scenarios/skills.yaml', 'tests/runner-e2e/chat-scenarios/app-permissions.yaml', 'tests/runner-e2e/chat-scenarios/activity.yaml',
  ]);
  assert.ok(repair.changedDefinitionFiles.every(value => /^[a-f0-9]{64}$/.test(value.sha256)));
  for (const declaration of declarations) {
    const value = row(declaration.scenarioId);
    assert.deepEqual(value.sourceFiles, declaration.sourceFiles);
    assert.equal(value.oracleVersion, declaration.oracleVersion);
    assert.equal(value.minimumRuns, declaration.minimumRunCount ?? declaration.expectedRunCount);
    assert.equal(value.maximumRuns, declaration.expectedRunCount);
    assert.equal(value.declaredTurnTimeoutMs, declaration.turnTimeoutMs);
    assert.equal(value.attemptTimeoutMs, declaration.attemptTimeoutMs);
  }
  assert.deepEqual(repair.changedFields.filter(change => ['minimumRuns', 'maximumRuns'].includes(change.field)), [{ key: 'skills.studio-test', field: 'maximumRuns', previous: 2, current: 3 }]);
  assert.deepEqual(repair.runtimeConditions.studio144Accounting, { key: 'skills.studio-test', previousMinimumRuns: 2, previousMaximumRuns: 2, minimumRuns: 2, maximumRuns: 3, requiredActualAcceptedRuns: 3, originalAttemptTimeoutMs: 540000, humanMessages: 1, condition: 'Initial CEO + real Studio worker + exactly one source-bound completion delivery;2-run no-delivery positive is rejected.' });
  assert.equal(repair.runtimeConditions.toolGuidance106.corePRUnmerged, false);
  assert.equal(repair.runtimeConditions.sdkPublicProof.scannerAndCanaryCertificatesUnchanged, true);
  assert.equal(repair.runtimeConditions.sdkPublicProof.sourceInputsChanged, true);
  assert.equal(repair.runtimeConditions.sdkPublicProof.registrySha256, "efa70621e9fb42aa185f7ee616a1a726aa3eccb367e67e28817cedf26ef2ade8");
  assert.equal(repair.runtimeConditions.sdkPublicProof.plugin558StillHeld, true);
  assert.equal(repair.runtimeConditions.sdkPublicProof.expectedLockSha256, "54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8");
  assert.equal(repair.runtimeConditions.sdkPublicProof.runtimeCompilerParserZodIdentitiesUnchanged, true);
  assert.equal(repair.runtimeConditions.toolProposal487.corePRUnmerged, false);
  assert.deepEqual(repair.runtimeConditions.toolProposal487.replay, {
  "corePR": 18742,
  "coreHead": "61996a96dd09e90a5788e8711a94fc5ae631f425",
  "corePRUnmerged": false,
  "condition": "A new Ask-first request only for an authenticated later same-person human intent after the prior decline; same-intent retry and derived or foreign sources remain denied. No approval/execution authority change.",
  "acceptedDirectSources": [
    "issue.comment",
    "issue.comment.reopen"
  ],
  "actualPostAssertionPGCasesPassed": 2
});
});
