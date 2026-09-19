import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DevinBaseModel } from './models.js';

const mocks = vi.hoisted(() => ({
  listDevinBaseModels: vi.fn<() => Promise<DevinBaseModel[]>>(),
  clearModelCache: vi.fn(),
}));

vi.mock('./models.js', () => ({
  listDevinBaseModels: mocks.listDevinBaseModels,
  clearModelCache: mocks.clearModelCache,
}));

import { getConfigSchema } from './config-schema.js';

function baseModel(overrides: Partial<DevinBaseModel> = {}): DevinBaseModel {
  return {
    id: 'swe-1.7',
    familyLabel: 'SWE-1.7',
    cost: { inputCostPerMTok: 0, outputCostPerMTok: 0, isFree: true },
    costLabel: 'Free',
    costTier: 'Free',
    maxContextTokens: 200_000,
    availableEfforts: ['auto'],
    hasFast: false,
    has1m: false,
    hasPriority: false,
    isBeta: false,
    isNew: false,
    defaultVariantId: 'swe-1-7',
    ...overrides,
  };
}

describe('getConfigSchema', () => {
  beforeEach(() => {
    mocks.listDevinBaseModels.mockReset();
  });

  it('keeps the axis fields (annotated) when catalog discovery fails, so stored values stay visible', async () => {
    mocks.listDevinBaseModels.mockRejectedValue(new Error('cli down'));
    const { fields } = await getConfigSchema();
    for (const key of ['contextSize', 'fastMode', 'priority']) {
      const f = fields.find((f) => f.key === key);
      expect(f, key).toBeDefined();
      expect(f?.hint).toContain('catalog is currently unreachable');
    }
  });

  it('returns command with default devin and no ACP-only fields', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([]);
    const { fields } = await getConfigSchema();
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('command');
    expect(keys).not.toContain('engine');
    expect(keys).not.toContain('acpArgs');
    expect(keys).not.toContain('adminCommand');
    expect(fields.find((f) => f.key === 'command')?.default).toBe('devin');
  });

  it('returns permissionMode default auto and the vendor-documented mode set', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([]);
    const { fields } = await getConfigSchema();
    const permissionMode = fields.find((f) => f.key === 'permissionMode');
    expect(permissionMode?.default).toBe('auto');
    const optionValues = (permissionMode as any)?.options?.map((o: any) => o.value);
    expect(optionValues).toEqual(
      expect.arrayContaining(['normal', 'auto', 'accept-edits', 'smart', 'dangerous', 'autonomous']),
    );
  });

  it('returns respectWorkspaceTrust default false', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([]);
    const { fields } = await getConfigSchema();
    const f = fields.find((f) => f.key === 'respectWorkspaceTrust');
    expect(f?.default).toBe(false);
  });

  it('includes instructionsFilePath as a no-prompt-injection field', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([]);
    const { fields } = await getConfigSchema();
    const f = fields.find((f) => f.key === 'instructionsFilePath');
    expect(f).toBeDefined();
    expect(f?.hint).toMatch(/auto-loads AGENTS\.md/i);
  });

  it('shows contextSize only when a base model has 1M context support', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([baseModel({ has1m: true })]);
    const { fields } = await getConfigSchema();
    expect(fields.map((f) => f.key)).toContain('contextSize');
  });

  it('hides contextSize when no base model has 1M context support', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([baseModel({ has1m: false })]);
    const { fields } = await getConfigSchema();
    expect(fields.map((f) => f.key)).not.toContain('contextSize');
  });

  it('shows fastMode only when a base model offers a fast lane', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([baseModel({ hasFast: true })]);
    const { fields } = await getConfigSchema();
    expect(fields.map((f) => f.key)).toContain('fastMode');
  });

  it('hides fastMode when no base model offers a fast lane', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([baseModel({ hasFast: false })]);
    const { fields } = await getConfigSchema();
    expect(fields.map((f) => f.key)).not.toContain('fastMode');
  });

  it('shows priority only when a base model offers a priority lane', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([baseModel({ hasPriority: true })]);
    const { fields } = await getConfigSchema();
    expect(fields.map((f) => f.key)).toContain('priority');
  });

  it('hides priority when no base model offers a priority lane', async () => {
    mocks.listDevinBaseModels.mockResolvedValue([baseModel({ hasPriority: false })]);
    const { fields } = await getConfigSchema();
    expect(fields.map((f) => f.key)).not.toContain('priority');
  });
});
