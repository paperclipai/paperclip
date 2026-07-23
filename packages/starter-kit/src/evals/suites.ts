/**
 * Starter-kit eval suite — the quality gate that proves the demo RAG bot is
 * measurable before handoff. Run with `pnpm --filter @chimeric/starter-kit eval`.
 *
 * Each case asserts the minimum a client would demand: the answer contains the
 * right facts, cites the right source, and stays grounded (no hallucination).
 */

import type { EvalSuite } from './runner.js';

export const STARTER_KIT_SUITE: EvalSuite = {
  id: 'starter-kit-demo',
  description: 'Quality gate for the starter-kit demo RAG agent',
  cases: [
    {
      id: 'refund-window',
      input: {
        question: 'How long do I have to return an item for a refund?',
        expectedContains: ['30 days'],
        expectedCitations: ['policy_refunds'],
        answerable: true,
      },
    },
    {
      id: 'refund-method',
      input: {
        question: 'How will I get my refund?',
        expectedContains: ['full refund'],
        expectedCitations: ['policy_refunds'],
        answerable: true,
      },
    },
    {
      id: 'business-hours',
      input: {
        question: 'What are your business hours?',
        expectedContains: ['9am', '5pm'],
        expectedCitations: ['hours'],
        answerable: true,
      },
    },
    {
      id: 'shipping-time',
      input: {
        question: 'How long does standard shipping take?',
        expectedContains: ['3-5 business days'],
        expectedCitations: ['shipping'],
        answerable: true,
      },
    },
    {
      id: 'warranty-cover',
      input: {
        question: 'Does the warranty cover accidental damage?',
        expectedContains: ['not covered'],
        expectedCitations: ['warranty'],
        answerable: true,
      },
    },
    {
      id: 'unanswerable',
      input: {
        question: 'What is the current stock price of the company?',
        expectedContains: [],
        expectedCitations: [],
        answerable: false,
      },
    },
  ],
};
