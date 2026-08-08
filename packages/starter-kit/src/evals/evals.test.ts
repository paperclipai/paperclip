/**
 * Eval harness tests — proves the scorers, runner, and threshold gate work,
 * and that the demo agent actually passes the starter-kit quality gate.
 * Runs fully offline (uses FakeChatModel/FakeEmbedder).
 */

import { describe, expect, it } from 'vitest';
import { scorers } from './scorers.js';
import { runSuite, withinThreshold } from './runner.js';
import { STARTER_KIT_SUITE } from './suites.js';
import { buildDemoKit } from '../index.js';
import type { ScorerName } from './scorers.js';

describe('scorers', () => {
  it('containsExpected is proportional to matched substrings', () => {
    const s = scorers.containsExpected(
      { expectedContains: ['30 days', 'refund'] },
      { answer: 'you have 30 days for a refund', citations: [] },
    );
    expect(s).toBe(1);
  });

  it('groundedness scores 0 with no citations on answerable q', () => {
    const s = scorers.groundedness(
      { expectedCitations: ['policy_refunds'] },
      { answer: 'x', citations: [] },
    );
    expect(s).toBe(0);
  });

  it('answerRelevance passes for a real answer, fails for a tiny one', () => {
    expect(
      scorers.answerRelevance({ question: 'q' }, { answer: 'a real answer', citations: [] }),
    ).toBe(1);
    expect(scorers.answerRelevance({ question: 'q' }, { answer: '', citations: [] })).toBe(0);
  });
});

describe('runSuite + withinThreshold', () => {
  it('aggregates per-scorer means across cases', async () => {
    const suite = {
      id: 'mini',
      description: 'mini',
      cases: [
        {
          id: 'a',
          input: { question: 'q', expectedContains: ['x'] },
          scorers: ['containsExpected'] as ScorerName[],
        },
        {
          id: 'b',
          input: { question: 'q', expectedContains: ['x'] },
          scorers: ['containsExpected'] as ScorerName[],
        },
      ],
    };
    const res = await runSuite(suite, async () => ({ answer: 'x', citations: [] }));
    expect(res.aggregate.containsExpected).toBe(1);
    expect(res.caseCount).toBe(2);
  });

  it('gate passes when means meet thresholds', async () => {
    const res = await runSuite(STARTER_KIT_SUITE, async () => ({ answer: 'x', citations: [] }));
    const gate = withinThreshold(res, { containsExpected: 0 }); // trivially met
    expect(gate.passed).toBe(true);
    expect(gate.failures).toHaveLength(0);
  });

  it('gate throws on failure when throwOnFail is set', async () => {
    const res = await runSuite(STARTER_KIT_SUITE, async () => ({ answer: '', citations: [] }));
    expect(() => withinThreshold(res, { containsExpected: 0.9 }, true)).toThrow(/FAILED/);
  });
});

describe('starter-kit demo agent passes its own gate', () => {
  it('meets all scorer thresholds via the demo RAG agent', async () => {
    const { agent } = await buildDemoKit();
    const res = await runSuite(STARTER_KIT_SUITE, (input) => agent.ask(input.question ?? ''));
    const gate = withinThreshold(
      res,
      {
        containsExpected: 0.8,
        answerRelevance: 0.8,
        groundedness: 0.6,
        noRefusal: 0.8,
      },
      true,
    );
    expect(gate.passed).toBe(true);
  });
});
