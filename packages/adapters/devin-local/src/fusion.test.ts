import { describe, expect, it } from 'vitest';
import {
  isFusionModelId,
  fusionSelectionError,
  parseFusionVariant,
} from './fusion.js';

const RATE =
  '$2 / 1M Input · $0.2 / 1M Cached input · $8 / 1M Output · $1 / 1M Sidekick input · $0 / 1M Sidekick cached input · $4 / 1M Sidekick output';

const PAIR_A = 'fusion-alpha-1-high-sidekick-beta-2-medium';
const PAIR_A_LABEL = 'Fusion (Alpha 1 High + Beta 2 Medium)';

describe('isFusionModelId', () => {
  it('recognizes fusion-prefixed and bare-family ids case-insensitively', () => {
    expect(isFusionModelId(PAIR_A)).toBe(true);
    expect(isFusionModelId('fusion')).toBe(true);
    expect(isFusionModelId(' Fusion-A-B ')).toBe(true);
    expect(isFusionModelId('FUSION-x-y')).toBe(true);
  });

  it('rejects non-fusion ids including prefix lookalikes', () => {
    expect(isFusionModelId('swe-1-7')).toBe(false);
    expect(isFusionModelId('fusionx-1-2')).toBe(false);
    expect(isFusionModelId('alpha-fusion-1')).toBe(false);
    expect(isFusionModelId('')).toBe(false);
  });
});

describe('fusionSelectionError', () => {
  it('rejects only the bare family, case-insensitive after trimming', () => {
    expect(fusionSelectionError('fusion')).toContain('Choose an explicit Fusion combination');
    expect(fusionSelectionError(' FUSION ')).toContain('Choose an explicit Fusion combination');
    expect(fusionSelectionError(PAIR_A)).toBeNull();
    expect(fusionSelectionError('')).toBeNull();
    expect(fusionSelectionError('swe-1-7')).toBeNull();
  });
});

describe('parseFusionVariant', () => {
  it('parses a supported pair into orchestrator and worker components', () => {
    const parsed = parseFusionVariant(PAIR_A, PAIR_A_LABEL, RATE);
    expect(parsed.version).toBe(1);
    expect(parsed.kind).toBe('fusion');
    expect(parsed.components?.orchestrator).toMatchObject({
      id: 'alpha-1-high',
      modelKey: 'alpha-1',
      effortKey: 'high',
      effortSource: 'uid',
      modifiers: [],
    });
    expect(parsed.components?.worker).toMatchObject({
      id: 'beta-2-medium',
      modelKey: 'beta-2',
      effortKey: 'medium',
      effortSource: 'uid',
      modifiers: [],
    });
  });

  it('keeps a priority worker modifier even when the label says Fast', () => {
    const parsed = parseFusionVariant(
      'fusion-alpha-1-high-fast-sidekick-beta-2-medium-priority',
      'Fusion (Alpha 1 High Thinking Fast + Beta 2 Medium Fast)',
      RATE,
    );
    expect(parsed.components?.orchestrator).toMatchObject({
      id: 'alpha-1-high-fast',
      effortKey: 'high',
      effortSource: 'uid',
      modifiers: ['fast'],
    });
    expect(parsed.components?.worker).toMatchObject({
      id: 'beta-2-medium-priority',
      effortKey: 'medium',
      effortSource: 'uid',
      modifiers: ['priority'],
    });
    expect(parsed.components?.worker.label).toContain('Fast');
    expect(parsed.components?.worker.modifiers).not.toContain('fast');
  });

  it('marks a fixed label-only effort tier with provenance instead of a UID suffix', () => {
    const parsed = parseFusionVariant(
      'fusion-alpha-1-high-sidekick-delta-4',
      'Fusion (Alpha 1 High + Delta 4 High)',
      RATE,
    );
    expect(parsed.components?.worker).toMatchObject({
      id: 'delta-4',
      effortKey: 'fixed:delta-4',
      effortLabel: 'High (fixed)',
      effortSource: 'label_fixed',
    });
  });

  it('marks a component with no encoded or declared effort as unspecified', () => {
    const parsed = parseFusionVariant(
      'fusion-omega-9-sidekick-psi-7',
      'Fusion (Omega 9 + Psi 7)',
      RATE,
    );
    expect(parsed.components?.orchestrator).toMatchObject({
      id: 'omega-9',
      effortKey: 'unspecified:omega-9',
      effortLabel: 'Not specified by catalog',
      effortSource: 'unspecified',
    });
    expect(parsed.components?.worker).toMatchObject({
      id: 'psi-7',
      effortKey: 'unspecified:psi-7',
      effortSource: 'unspecified',
    });
  });

  it('goes opaque on contradictory explicit effort claims', () => {
    const parsed = parseFusionVariant(
      PAIR_A,
      'Fusion (Alpha 1 Low + Beta 2 Medium)',
      RATE,
    );
    expect(parsed.components).toBeNull();
  });

  it('goes opaque on ambiguous separators and unknown trailing tokens', () => {
    for (const uid of [
      'fusion-alpha-1-high',
      'fusion-a-sidekick-b-sidekick-c',
      'fusion--sidekick-beta-2-medium',
      'fusion-alpha-1-high-sidekick-',
      'fusion-alpha-1-high-turbo-sidekick-beta-2-medium',
      'fusion-alpha-1-high-high-sidekick-beta-2-medium',
    ]) {
      expect(parseFusionVariant(uid, PAIR_A_LABEL, RATE).components).toBeNull();
    }
  });

  it('goes opaque when the label grammar is unrecognized', () => {
    for (const label of [
      PAIR_A,
      'Fusion Alpha + Beta',
      'Fusion (Alpha 1 High + Beta 2 Medium',
      'Fusion (Alpha 1 High)',
      'Fusion (Alpha 1 High + Beta 2 Medium + Gamma 3)',
    ]) {
      const parsed = parseFusionVariant(PAIR_A, label, RATE);
      expect(parsed.components).toBeNull();
    }
  });

  it('preserves the paired catalog model label even when it differs from the UID stem', () => {
    const parsed = parseFusionVariant(
      PAIR_A,
      'Fusion (Zeta 9 High + Beta 2 Medium)',
      RATE,
    );
    expect(parsed.components?.orchestrator.modelLabel).toBe('Zeta 9');
    expect(parsed.components?.orchestrator.modelKey).toBe('alpha-1');
  });

  it('keeps dotted vendor label text instead of collapsing it to the slug', () => {
    const parsed = parseFusionVariant(
      'fusion-acme-9-9-high-sidekick-beta-2-medium',
      'Fusion (Acme 9.9 High + Beta 2 Medium)',
      null,
    );
    expect(parsed.components?.orchestrator.modelLabel).toBe('Acme 9.9');
    expect(parsed.components?.orchestrator.modelKey).toBe('acme-9-9');
  });

  it('parses per-role rates by named segment in any order and preserves explicit zero', () => {
    const reordered =
      '$4 / 1M Sidekick output · $1 / 1M Sidekick input · $8 / 1M Output · $0 / 1M Sidekick cached input · $2 / 1M Input · $0.2 / 1M Cached input';
    const parsed = parseFusionVariant(PAIR_A, PAIR_A_LABEL, reordered);
    expect(parsed.rates).toEqual({
      orchestrator: {
        inputPerMillion: 2,
        cachedInputPerMillion: 0.2,
        outputPerMillion: 8,
      },
      worker: {
        inputPerMillion: 1,
        cachedInputPerMillion: 0,
        outputPerMillion: 4,
      },
    });
    expect(parsed.costSummary).toBe(reordered);
  });

  it('keeps unknown rate fields null rather than zero or summed', () => {
    const partial = parseFusionVariant(PAIR_A, PAIR_A_LABEL, '$2 / 1M Input');
    expect(partial.rates?.orchestrator.inputPerMillion).toBe(2);
    expect(partial.rates?.orchestrator.outputPerMillion).toBeNull();
    expect(partial.rates?.worker.inputPerMillion).toBeNull();

    const none = parseFusionVariant(PAIR_A, PAIR_A_LABEL, null);
    expect(none.rates).toBeNull();
    expect(none.costSummary).toBeNull();
  });

  it('treats conflicting duplicate rate segments as unknown for that field', () => {
    const parsed = parseFusionVariant(
      PAIR_A,
      PAIR_A_LABEL,
      '$2 / 1M Input · $9 / 1M Input · $8 / 1M Output',
    );
    expect(parsed.rates?.orchestrator.inputPerMillion).toBeNull();
    expect(parsed.rates?.orchestrator.outputPerMillion).toBe(8);
  });

  it.each([
    'garbage $2 / 1M Input',
    '$-2 / 1M Input',
    '$1e3 / 1M Input',
    '$Infinity / 1M Input',
  ])('treats the invalid numeric segment "%s" as unknown', (card) => {
    const parsed = parseFusionVariant(PAIR_A, PAIR_A_LABEL, card);
    expect(parsed.rates?.orchestrator.inputPerMillion).toBeNull();
    expect(parsed.costSummary).toBe(card);
  });

  it('retains an identical duplicate rate segment', () => {
    const parsed = parseFusionVariant(
      PAIR_A,
      PAIR_A_LABEL,
      '$2 / 1M Input · $2 / 1M Input · $8 / 1M Output',
    );
    expect(parsed.rates?.orchestrator.inputPerMillion).toBe(2);
    expect(parsed.rates?.orchestrator.outputPerMillion).toBe(8);
  });

  it('keeps a conflicting rate field unknown even when a later segment restates the original', () => {
    const parsed = parseFusionVariant(
      PAIR_A,
      PAIR_A_LABEL,
      '$2 / 1M Input · $9 / 1M Input · $2 / 1M Input',
    );
    expect(parsed.rates?.orchestrator.inputPerMillion).toBeNull();
  });

  it('marks a field unknown when a valid segment is duplicated by an invalid one', () => {
    const parsed = parseFusionVariant(
      PAIR_A,
      PAIR_A_LABEL,
      '$2 / 1M Input · $x / 1M Input',
    );
    expect(parsed.rates?.orchestrator.inputPerMillion).toBeNull();
  });

  it('never materializes non-allowlisted segment names such as __proto__', () => {
    const parsed = parseFusionVariant(
      PAIR_A,
      PAIR_A_LABEL,
      '$5 / 1M __proto__ · $2 / 1M Input',
    );
    expect(parsed.rates?.orchestrator.inputPerMillion).toBe(2);
    expect(Object.keys(parsed.rates!.orchestrator)).toEqual([
      'inputPerMillion',
      'cachedInputPerMillion',
      'outputPerMillion',
    ]);
    expect(Object.keys(parsed.rates!.worker)).toEqual([
      'inputPerMillion',
      'cachedInputPerMillion',
      'outputPerMillion',
    ]);
  });

  it('treats a component with an empty UID token as ambiguous', () => {
    const parsed = parseFusionVariant(
      'fusion-alpha--1-high-sidekick-beta-2-medium',
      'Fusion (Alpha 1 High + Beta 2 Medium)',
      RATE,
    );
    expect(parsed.components).toBeNull();
  });

  it('supports the legacy MTok spelling', () => {
    const parsed = parseFusionVariant(
      PAIR_A,
      PAIR_A_LABEL,
      '$2 / MTok In · $8 / MTok Out · $1 / 1M Sidekick input · $4 / 1M Sidekick output',
    );
    expect(parsed.rates?.orchestrator.inputPerMillion).toBe(2);
    expect(parsed.rates?.orchestrator.outputPerMillion).toBe(8);
    expect(parsed.rates?.worker.inputPerMillion).toBe(1);
  });
});
