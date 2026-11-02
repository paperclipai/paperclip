import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('./chat-full-catalog-testops-manifest.json', import.meta.url));
const manifest = JSON.parse(bytes);
const legacy = new Set(['tasks.create-backlog', 'tasks.delegate-announcement']);
const surfaces = new Set(['agent-chat', 'browser-boundary', 'scoped-external-assistant', 'native-slack-thread']);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;

export function validateFullCatalogManifest(value) {
  if (value?.schema !== 'paperclip.chat-full-catalog-testops-manifest/v1'
    || !/^[a-f0-9]{40}$/.test(value.targetSha ?? '') || !/^[a-f0-9]{40}$/.test(value.metadataSourceSha ?? '')
    || value.profile !== 'runner-opencode' || value.model !== 'openrouter/deepseek/deepseek-v4.1-flash-1017'
    || !Array.isArray(value.cases) || value.cases.length !== 244) throw new Error('chat_full_catalog_manifest_invalid');
  for (const row of value.cases) {
    const task = legacy.has(row.key) ? row.key.slice(6) : row.key;
    if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(row.key ?? '') || row.canonicalScenario !== row.key || row.scenario !== task
      || row.area !== row.key.split('.')[0] || !text(row.name) || !text(row.title)
      || row.executionId !== `chat-features.runner-opencode.local.${task}`
      || row.fullName !== `paperclip.Product E2E.chat-features.${row.key}`
      || JSON.stringify(row.aliases) !== JSON.stringify(legacy.has(row.key) ? [`paperclip.Product E2E.chat-features.${task}`] : [])
      || !nonnegative(row.minimumRuns) || !nonnegative(row.maximumRuns) || row.minimumRuns > row.maximumRuns
      || !nonnegative(row.turnTimeoutMs) || !nonnegative(row.declaredTurnTimeoutMs)
      || !Number.isSafeInteger(row.attemptTimeoutMs) || row.attemptTimeoutMs <= 30_000
      || !surfaces.has(row.journeyKind) || JSON.stringify(row.surface) !== JSON.stringify([row.journeyKind])
      || !Array.isArray(row.coverageGaps) || !row.coverageGaps.every(text)
      || !Array.isArray(row.requiredCredentials) || !row.requiredCredentials.every(text)
      || row.externalInput !== null && (typeof row.externalInput !== 'object' || Array.isArray(row.externalInput))
      || row.installedSource !== null && !text(row.installedSource)
      || ![row.originalQuery, row.originalContext, row.expectedOutcome, row.oracleVersion, row.evidenceKind, row.evidenceReadiness].every(text)
      || !Array.isArray(row.capabilities) || row.capabilities.length === 0 || !row.capabilities.every(text)
      || !Array.isArray(row.sourceFiles) || row.sourceFiles.length === 0 || !row.sourceFiles.every(text)
      || row.checks !== null && (!Number.isSafeInteger(row.checks) || row.checks <= 0)
      || row.screenshot !== null && !/^[a-z0-9-]+\.png$/.test(row.screenshot)) throw new Error('chat_full_catalog_row_invalid');
  }
  for (const key of ['key', 'executionId', 'fullName']) {
    if (new Set(value.cases.map(row => row[key])).size !== 244) throw new Error('chat_full_catalog_identity_conflict');
  }
  if (!Array.isArray(value.source?.scenarioFiles) || value.source.scenarioFiles.length !== 35
    || !/^[a-f0-9]{64}$/.test(value.source.descriptorSha256 ?? '')) throw new Error('chat_full_catalog_provenance_invalid');
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

validateFullCatalogManifest(manifest);
export const catalogTargetSha = manifest.targetSha;
export const catalogManifestSha256 = createHash('sha256').update(bytes).digest('hex');
export const fullCatalogPlanName = 'Chat feature catalog — OpenCode 1017 (candidate)';
export const fullCatalogCases = freeze(manifest.cases);
