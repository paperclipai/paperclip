import { createHash } from 'node:crypto';
import { catalogTargetSha, fullCatalogCases, fullCatalogPlanName } from './chat-full-catalog-testops-manifest.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = code => { throw new Error(`chat_full_catalog_testops_${code}`); };
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const metadataFields = ['name', 'automated', 'description', 'precondition', 'expectedResult'];
const marker = (operation, key) => `${operation}_${createHash('sha256').update(key).digest('hex').replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)))}`;

function manifestIndex() {
  if (!Array.isArray(fullCatalogCases) || fullCatalogCases.length !== 244
    || !/^[a-f0-9]{40}$/.test(catalogTargetSha) || !fullCatalogPlanName) fail('manifest');
  const names = new Map(), keys = new Set();
  for (const row of fullCatalogCases) {
    if (!row.key || keys.has(row.key) || row.key !== row.canonicalScenario || !row.fullName
      || !Array.isArray(row.aliases) || !row.name || !row.originalQuery || !row.originalContext || !row.expectedOutcome
      || !Array.isArray(row.capabilities) || !Array.isArray(row.surface)
      || !Array.isArray(row.coverageGaps) || !Array.isArray(row.requiredCredentials)) fail('manifest');
    keys.add(row.key);
    for (const name of [row.fullName, ...row.aliases]) {
      if (typeof name !== 'string' || !name || names.has(name)) fail('manifest_alias');
      names.set(name, row);
    }
  }
  return names;
}

function desiredMetadata(row) {
  const gaps = row.coverageGaps.length ? row.coverageGaps.join('\n') : 'No coverage gap is declared in the source metadata; live qualification is separate.';
  const requirements = [
    `Full-catalog lane targets candidate ${catalogTargetSha}; other lanes keep their own actual source; target is recorded per result. This registration does not qualify current master or record a PASS.`,
    `Assumed context:\n${row.originalContext}`,
    `Required credential names: ${row.requiredCredentials.join(', ') || 'None declared for this case; the controller profile credential is separate.'}`,
    `External input contract: ${row.externalInput == null ? 'None declared.' : JSON.stringify(row.externalInput)}`,
    `Installed-source requirement: ${row.installedSource ?? 'None declared.'}`,
    `Source evidence kind: ${row.evidenceKind}`,
    `Source screenshot carrier: ${row.screenshot ?? 'None declared.'}`,
    `Source evidence readiness: ${row.evidenceReadiness}`,
    `Coverage gaps (the original oracle remains unchanged):\n${gaps}`,
  ];
  return {
    name: row.name,
    automated: true,
    description: [
      `Canonical chat scenario: ${row.canonicalScenario}`,
      `Full-catalog lane targets candidate ${catalogTargetSha}; other lanes keep their own actual source; target is recorded per result. Executable registration is not a result or a qualification claim.`,
      `Human request:\n${row.originalQuery}`,
      `Capabilities: ${row.capabilities.join(', ') || 'None declared.'}`,
      `Surfaces: ${row.surface.join(', ') || 'None declared.'}`,
      `Native OpenCode / OpenRouter DeepSeek1017. Original source bounds and evidence gates apply.`,
      `Accounted work runs: minimum ${row.minimumRuns ?? 'unknown'}, maximum ${row.maximumRuns ?? 'unknown'}. Turn limit: ${row.turnTimeoutMs} ms. Attempt limit: ${row.attemptTimeoutMs} ms.`,
      `Coverage gaps:\n${gaps}`,
    ].join('\n\n'),
    precondition: requirements.join('\n\n'),
    expectedResult: row.expectedOutcome,
  };
}

function caseMetadata(actual) {
  return Object.fromEntries(metadataFields.map(field => [field, actual[field]]));
}

function assertCase(actual, row, caseId, registeredFullName) {
  if (actual?.id !== caseId || actual.projectId !== 1 || actual.deleted === true
    || typeof actual.automated !== 'boolean' || actual.fullName !== registeredFullName
    || ![row.fullName, ...row.aliases].includes(actual.fullName)) fail('case_identity');
}

function assertSelection(plan, allowedIds, exact = false) {
  const selection = plan.treeSelection;
  if (!positive(plan.id) || plan.projectId !== 1 || plan.name !== fullCatalogPlanName
    || !selection || selection.inverted !== false || !Array.isArray(selection.leafsInclude)
    || selection.leafsInclude.some(value => !positive(value) || !allowedIds.has(value))
    || new Set(selection.leafsInclude).size !== selection.leafsInclude.length
    || !Number.isSafeInteger(plan.testCasesCount) || plan.testCasesCount !== selection.leafsInclude.length
    || ['groupsInclude', 'groupsExclude', 'leafsExclude', 'path'].some(key => selection[key] != null
      && (!Array.isArray(selection[key]) || selection[key].length !== 0))
    || plan.baseRql != null && plan.baseRql !== ''
    || exact && selection.leafsInclude.length !== allowedIds.size) fail('plan_scope');
}

export async function inspectFullCatalog(api) {
  const names = manifestIndex(), seen = new Set(), found = new Map();
  let totalPages, totalElements;
  for (let page = 0; page < 10; page++) {
    const listed = await api(`/api/testcase?${new URLSearchParams({ projectId: '1', page: String(page), size: '100', sort: 'id,asc' })}`);
    if (!Array.isArray(listed?.content) || listed.content.length > 100 || listed.number !== page
      || !Number.isSafeInteger(listed.totalPages) || listed.totalPages < 0 || listed.totalPages > 10
      || !Number.isSafeInteger(listed.totalElements) || listed.totalElements < 0 || listed.totalElements > 1000
      || listed.totalPages !== Math.ceil(listed.totalElements / 100)
      || listed.content.length !== Math.min(100, Math.max(0, listed.totalElements - page * 100))
      || totalPages !== undefined && (totalPages !== listed.totalPages || totalElements !== listed.totalElements)) fail('catalog_page');
    totalPages = listed.totalPages; totalElements = listed.totalElements;
    const ids = listed.content.map(value => {
      if (!positive(value.id) || seen.has(value.id)) fail('catalog_identity');
      seen.add(value.id); return value.id;
    });
    for (let offset = 0; offset < ids.length; offset += 4) {
      const batch = ids.slice(offset, offset + 4);
      const actuals = await Promise.all(batch.map(caseId => api(`/api/testcase/${caseId}`)));
      for (const [index, actual] of actuals.entries()) {
        if (actual?.id !== batch[index] || actual.projectId !== 1
          || actual.fullName != null && typeof actual.fullName !== 'string') fail('catalog_case');
        const row = names.get(actual.fullName);
        if (!row) continue;
        assertCase(actual, row, actual.id, actual.fullName);
        if (found.has(row.key)) fail('case_alias_conflict');
        found.set(row.key, { ...row, caseId: actual.id, registeredFullName: actual.fullName, currentMetadata: caseMetadata(actual) });
      }
    }
    if (page + 1 >= totalPages) break;
  }
  if (seen.size !== totalElements) fail('catalog_incomplete');
  const listedPlans = await api(`/api/testplan?${new URLSearchParams({ projectId: '1', name: fullCatalogPlanName, page: '0', size: '100' })}`);
  if (!Array.isArray(listedPlans?.content) || listedPlans.content.length > 100
    || !Number.isSafeInteger(listedPlans.totalPages) || listedPlans.totalPages < 0 || listedPlans.totalPages > 1
    || !Number.isSafeInteger(listedPlans.totalElements) || listedPlans.totalElements !== listedPlans.content.length) fail('plan_page');
  const plans = listedPlans.content.filter(plan => plan.name === fullCatalogPlanName);
  if (plans.length > 1) fail('plan_conflict');
  const cases = fullCatalogCases.flatMap(row => found.has(row.key) ? [found.get(row.key)] : []);
  if (plans.length) {
    if (!positive(plans[0].id) || plans[0].projectId !== 1) fail('plan_identity');
    const actual = await api(`/api/testplan/${plans[0].id}`);
    if (actual?.id !== plans[0].id) fail('plan_identity');
    assertSelection(actual, new Set(cases.map(row => row.caseId)));
    plans[0] = actual;
  }
  return { projectId: 1, catalogCount: totalElements, cases, plans };
}

export async function reconcileFullCatalog(api, markOnce) {
  if (typeof markOnce !== 'function') fail('mutation_marker');
  const inspected = await inspectFullCatalog(api), existing = new Map(inspected.cases.map(row => [row.key, row]));
  const reconciled = [];
  for (const row of fullCatalogCases) {
    const wanted = desiredMetadata(row);
    let bound = existing.get(row.key);
    if (!bound) {
      await markOnce(marker('create_case', row.key));
      const created = await api('/api/testcase', 'POST', { projectId: 1, fullName: row.fullName, ...wanted });
      if (!positive(created?.id) || reconciled.some(value => value.caseId === created.id)) fail('created_case');
      const actual = await api(`/api/testcase/${created.id}`);
      assertCase(actual, row, created.id, row.fullName);
      if (!equal(caseMetadata(actual), wanted)) fail('case_metadata');
      bound = { ...row, caseId: actual.id, registeredFullName: actual.fullName };
    } else if (!equal(bound.currentMetadata, wanted)) {
      await markOnce(marker('patch_case', row.key));
      await api(`/api/testcase/${bound.caseId}`, 'PATCH', wanted);
      const actual = await api(`/api/testcase/${bound.caseId}`);
      assertCase(actual, row, bound.caseId, bound.registeredFullName);
      if (!equal(caseMetadata(actual), wanted)) fail('case_metadata');
    }
    reconciled.push({ ...row, caseId: bound.caseId, registeredFullName: bound.registeredFullName });
  }
  const checked = await inspectFullCatalog(api);
  if (checked.cases.length !== fullCatalogCases.length
    || checked.cases.some((row, index) => row.caseId !== reconciled[index].caseId
      || row.registeredFullName !== reconciled[index].registeredFullName
      || !equal(row.currentMetadata, desiredMetadata(fullCatalogCases[index])))) fail('reconciliation_changed');
  const selection = { inverted: false, leafsInclude: reconciled.map(row => row.caseId), groupsInclude: [], groupsExclude: [], leafsExclude: [] };
  let plan = checked.plans[0];
  if (!plan) {
    await markOnce('create_plan');
    const created = await api('/api/testplan', 'POST', { projectId: 1, name: fullCatalogPlanName, treeSelection: selection });
    if (!positive(created?.id)) fail('created_plan');
    plan = await api(`/api/testplan/${created.id}`);
    if (plan?.id !== created.id) fail('created_plan');
  } else if (!equal([...plan.treeSelection.leafsInclude].sort((a, b) => a - b), [...selection.leafsInclude].sort((a, b) => a - b))) {
    await markOnce('patch_plan');
    await api(`/api/testplan/${plan.id}`, 'PATCH', { treeSelection: selection });
    plan = await api(`/api/testplan/${plan.id}`);
  }
  assertSelection(plan, new Set(selection.leafsInclude), true);
  return { planId: plan.id, cases: reconciled };
}
