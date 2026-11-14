import test from 'node:test';
import assert from 'node:assert/strict';
import { fullCatalogCases, fullCatalogPlanName, catalogTargetSha } from './chat-full-catalog-testops-manifest.mjs';
import { inspectFullCatalog, reconcileFullCatalog } from './chat-full-catalog-testops-reconcile.mjs';

const clone = value => structuredClone(value);
const backlog = fullCatalogCases.find(row => row.canonicalScenario === 'tasks.create-backlog');
const pilotKeys = ['instance-operations.restart-service', 'projects.project-defaults', 'projects.project-work'];
function storedCase(row, caseId, fullName = row.fullName) {
  return { id: caseId, projectId: 1, fullName, automated: true, deleted: false, name: row.name,
    description: 'Retained prior description', precondition: '', expectedResult: '', retainedHistory: ['original measurement'] };
}
function fixture({ existing = true, partialPlan = false, transform = value => value, uncertain = null } = {}) {
  const cases = new Map(), plans = new Map(), calls = [], claimed = new Set();
  const unrelated = { id: 2, projectId: 1, fullName: 'unrelated.original.case', automated: true, name: 'Unrelated', retainedHistory: ['unchanged'] };
  cases.set(unrelated.id, clone(unrelated));
  if (existing) {
    cases.set(388, storedCase(backlog, 388, backlog.aliases[0]));
    pilotKeys.forEach((key, index) => cases.set(500 + index, storedCase(fullCatalogCases.find(row => row.key === key), 500 + index)));
  }
  plans.set(36, { id: 36, projectId: 1, name: 'Chat feature evals', testCasesCount: 1, treeSelection: { inverted: false, leafsInclude: [388] } });
  plans.set(40, { id: 40, projectId: 1, name: 'Chat completion pilot — OpenCode 1017', testCasesCount: 3,
    treeSelection: { inverted: false, leafsInclude: [500, 501, 502] } });
  if (partialPlan) plans.set(90, { id: 90, projectId: 1, name: fullCatalogPlanName, testCasesCount: 2,
    treeSelection: { inverted: false, leafsInclude: [388, 500] } });
  let nextId = 10000, uncertainUsed = false;
  const api = async (route, method = 'GET', body) => {
    calls.push({ route, method, ...(body === undefined ? {} : { body: clone(body) }) });
    const url = new URL(route, 'https://mock.invalid');
    let value;
    if (route.startsWith('/api/testcase?')) {
      const rows = [...cases.values()].sort((a, b) => a.id - b.id), page = Number(url.searchParams.get('page'));
      value = { content: rows.slice(page * 100, (page + 1) * 100).map(row => ({ id: row.id })),
        number: page, totalPages: Math.ceil(rows.length / 100), totalElements: rows.length };
    } else if (/^\/api\/testcase\/\d+$/.test(route)) {
      const caseId = Number(route.split('/').at(-1));
      if (method === 'PATCH') Object.assign(cases.get(caseId), clone(body));
      else assert.equal(method, 'GET');
      value = cases.get(caseId);
    } else if (route === '/api/testcase' && method === 'POST') {
      if (uncertain === 'before' && !uncertainUsed) { uncertainUsed = true; throw new Error('uncertain transport'); }
      value = { ...clone(body), id: nextId++, deleted: false };
      cases.set(value.id, clone(value));
      if (uncertain === 'after' && !uncertainUsed) { uncertainUsed = true; throw new Error('uncertain transport'); }
    } else if (route.startsWith('/api/testplan?')) {
      const rows = [...plans.values()].filter(row => row.name.includes(url.searchParams.get('name')));
      value = { content: rows, totalElements: rows.length, totalPages: rows.length ? 1 : 0 };
    } else if (/^\/api\/testplan\/\d+$/.test(route)) {
      const planId = Number(route.split('/').at(-1));
      if (method === 'PATCH') {
        Object.assign(plans.get(planId), clone(body));
        plans.get(planId).testCasesCount = body.treeSelection.leafsInclude.length;
      } else assert.equal(method, 'GET');
      value = plans.get(planId);
    } else if (route === '/api/testplan' && method === 'POST') {
      value = { ...clone(body), id: 90, testCasesCount: body.treeSelection.leafsInclude.length };
      plans.set(value.id, clone(value));
    } else assert.fail(`Unexpected ${method} ${route}`);
    return clone(transform(clone(value), { route, method, body, cases, plans, calls }));
  };
  const markOnce = async stage => {
    assert.match(stage, /^[a-z_]{1,80}$/);
    if (claimed.has(stage)) throw new Error('already attempted');
    claimed.add(stage); calls.push({ marker: stage });
  };
  return { api, markOnce, cases, plans, calls, claimed, unrelated };
}
const writes = f => f.calls.filter(row => row.method && row.method !== 'GET');

test('reconciles the actual 244-row manifest while retaining legacy388, pilot identities, history and unrelated plans', async () => {
  const f = fixture(), oldPlans = clone([...f.plans.values()]);
  const receipt = await reconcileFullCatalog(f.api, f.markOnce);
  assert.equal(receipt.cases.length, 244); assert.equal(receipt.planId, 90);
  assert.equal(new Set(receipt.cases.map(row => row.caseId)).size, 244);
  const boundBacklog = receipt.cases.find(row => row.key === backlog.key);
  assert.equal(boundBacklog.caseId, 388); assert.equal(boundBacklog.fullName, backlog.fullName);
  assert.equal(boundBacklog.registeredFullName, backlog.aliases[0]);
  assert.equal(f.cases.get(388).fullName, backlog.aliases[0]);
  assert.deepEqual(f.cases.get(388).retainedHistory, ['original measurement']);
  assert.deepEqual(f.cases.get(2), f.unrelated);
  oldPlans.forEach(plan => assert.deepEqual(f.plans.get(plan.id), plan));
  assert.equal(writes(f).filter(row => row.route === '/api/testcase').length, 240);
  for (const bound of receipt.cases) {
    const actual = f.cases.get(bound.caseId);
    assert.equal(actual.automated, true); assert.equal(actual.expectedResult, bound.expectedOutcome);
    assert.ok(actual.description.includes(bound.originalQuery));
    assert.ok(actual.precondition.includes(bound.originalContext));
    assert.ok(actual.description.includes(catalogTargetSha));
    for (const field of ['description', 'precondition']) {
      assert.ok(actual[field].includes(`Full-catalog lane targets candidate ${catalogTargetSha}; other lanes keep their own actual source; target is recorded per result.`));
    }
    assert.ok(actual.precondition.includes(`Source evidence kind: ${bound.evidenceKind}`));
    assert.ok(actual.precondition.includes(`Source screenshot carrier: ${bound.screenshot ?? 'None declared.'}`));
    assert.ok(actual.precondition.includes(`Source evidence readiness: ${bound.evidenceReadiness}`));
    bound.coverageGaps.forEach(gap => assert.ok(actual.description.includes(gap)));
    bound.requiredCredentials.forEach(name => assert.ok(actual.precondition.includes(name)));
    assert.equal(Object.hasOwn(actual, 'statusId'), false);
  }
  assert.deepEqual(f.plans.get(90).treeSelection.leafsInclude, receipt.cases.map(row => row.caseId));
  for (const [index, call] of f.calls.entries()) if (call.method && call.method !== 'GET') {
    assert.ok(f.calls[index - 1].marker);
    if (call.method === 'PATCH' && call.route.startsWith('/api/testcase/')) {
      assert.deepEqual(Object.keys(call.body).sort(), ['automated', 'description', 'expectedResult', 'name', 'precondition']);
    }
  }
});

test('a second full reconciliation performs no writes or new mutation claims', async () => {
  const f = fixture();
  const first = await reconcileFullCatalog(f.api, f.markOnce), count = writes(f).length, claims = f.claimed.size;
  const second = await reconcileFullCatalog(f.api, f.markOnce);
  assert.deepEqual(second, first); assert.equal(writes(f).length, count); assert.equal(f.claimed.size, claims);
});

test('resumes an owned partial plan by extending only its explicit known-case selection', async () => {
  const f = fixture({ partialPlan: true });
  const value = await reconcileFullCatalog(f.api, f.markOnce);
  assert.equal(value.planId, 90);
  assert.equal(writes(f).filter(row => row.route === '/api/testplan').length, 0);
  assert.deepEqual(writes(f).filter(row => row.route === '/api/testplan/90').map(row => Object.keys(row.body)), [['treeSelection']]);
  assert.equal(f.plans.get(90).testCasesCount, 244);
});

for (const kind of ['alias', 'canonical']) {
  test(`rejects duplicate ${kind} case identities before any mutation`, async () => {
    const f = fixture();
    const row = kind === 'alias' ? backlog : fullCatalogCases.find(value => !value.aliases.length);
    if (kind === 'canonical') f.cases.set(600, storedCase(row, 600));
    f.cases.set(601, storedCase(row, 601));
    await assert.rejects(reconcileFullCatalog(f.api, f.markOnce), /case_alias_conflict/);
    assert.equal(writes(f).length, 0); assert.equal(f.claimed.size, 0);
  });
}

test('a matching-name plan containing a foreign case is not overwritten', async () => {
  const f = fixture({ partialPlan: true });
  f.plans.get(90).treeSelection.leafsInclude = [2]; f.plans.get(90).testCasesCount = 1;
  await assert.rejects(reconcileFullCatalog(f.api, f.markOnce), /plan_scope/);
  assert.equal(writes(f).length, 0);
});

test('duplicate dedicated plan names stop before case metadata patches', async () => {
  const f = fixture({ partialPlan: true }); f.plans.set(91, { ...clone(f.plans.get(90)), id: 91 });
  await assert.rejects(reconcileFullCatalog(f.api, f.markOnce), /plan_conflict/);
  assert.equal(writes(f).length, 0);
});

test('per-ID project mismatch stops before writes even when list IDs look valid', async () => {
  const f = fixture({ transform: (value, { route }) => route === '/api/testcase/388' ? { ...value, projectId: 2 } : value });
  await assert.rejects(reconcileFullCatalog(f.api, f.markOnce), /catalog_case/);
  assert.equal(writes(f).length, 0);
});

for (const mode of ['changed_total', 'duplicate_id', 'short_page']) {
  test(`complete pagination rejects ${mode} without writing`, async () => {
    const f = fixture({ transform: (value, { route }) => {
      if (!route.startsWith('/api/testcase?')) return value;
      if (mode === 'changed_total' && value.number === 1) { value.totalElements++; }
      if (mode === 'duplicate_id' && value.number === 1) value.content[0].id = 2;
      if (mode === 'short_page' && value.number === 0) value.content.pop();
      return value;
    } });
    for (let i = 0; i < 110; i++) f.cases.set(2000 + i, { ...clone(f.unrelated), id: 2000 + i, fullName: `foreign.${i}` });
    await assert.rejects(reconcileFullCatalog(f.api, f.markOnce), /catalog_page|catalog_identity/);
    assert.equal(writes(f).length, 0);
  });
}

test('an uncertain unapplied case POST is not automatically resent with the same marker', async () => {
  const f = fixture({ existing: false, uncertain: 'before' });
  await assert.rejects(reconcileFullCatalog(f.api, f.markOnce), /uncertain transport/);
  await assert.rejects(reconcileFullCatalog(f.api, f.markOnce), /already attempted/);
  assert.equal(writes(f).length, 1); assert.equal(f.plans.has(90), false);
});

test('resumption reuses a case durably created before an uncertain response rather than creating it twice', async () => {
  const f = fixture({ existing: false, uncertain: 'after' });
  await assert.rejects(reconcileFullCatalog(f.api, f.markOnce), /uncertain transport/);
  const createdId = [...f.cases.keys()].find(id => id !== 2);
  const value = await reconcileFullCatalog(f.api, f.markOnce);
  assert.equal(value.cases[0].caseId, createdId);
  assert.equal(writes(f).filter(row => row.route === '/api/testcase').length, 244);
  assert.equal(new Set(value.cases.map(row => row.caseId)).size, 244);
});

test('a duplicate appearing after case updates prevents final plan admission', async () => {
  let injected = false;
  const f = fixture({ transform: (value, { route, cases, calls }) => {
    if (!injected && route.startsWith('/api/testcase?') && calls.some(row => row.method === 'POST')) {
      injected = true; cases.set(9000, storedCase(backlog, 9000));
      const rows = [...cases.values()].sort((a, b) => a.id - b.id);
      return { ...value, content: rows.slice(0, 100).map(row => ({ id: row.id })),
        totalElements: rows.length, totalPages: Math.ceil(rows.length / 100) };
    }
    return value;
  } });
  await assert.rejects(reconcileFullCatalog(f.api, f.markOnce), /case_alias_conflict/);
  assert.equal(writes(f).filter(row => row.route.startsWith('/api/testplan')).length, 0);
});

test('inspection alone reports known bindings without mutation markers or writes', async () => {
  const f = fixture();
  const value = await inspectFullCatalog(f.api);
  assert.equal(value.cases.length, 4); assert.equal(value.plans.length, 0);
  assert.equal(value.cases.find(row => row.caseId === 388).registeredFullName, backlog.aliases[0]);
  assert.equal(writes(f).length, 0);
});
