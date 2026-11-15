import { describe, expect, it } from 'vitest';
import { unprocessable } from '../errors.js';
import { skillSourceRetryAt } from '../services/skill-source-retry.js';

describe('skill source retry scheduling', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  it('backs off repeated failures and caps ordinary retries at an hour', () => {
    expect(skillSourceRetryAt(new Error('failed'), 0, now).getTime() - now.getTime()).toBe(300_000);
    expect(skillSourceRetryAt(new Error('failed'), 2, now).getTime() - now.getTime()).toBe(1_200_000);
    expect(skillSourceRetryAt(new Error('failed'), 20, now).getTime() - now.getTime()).toBe(3_600_000);
  });
  it('honors provider rate limits without accepting unbounded or invalid delays', () => {
    const retry = (delay: number) => skillSourceRetryAt(unprocessable('Limited', { retryAfterMs: delay }), 0, now).getTime() - now.getTime();
    expect(retry(7_200_000)).toBe(7_200_000);
    expect(retry(100)).toBe(300_000);
    expect(retry(Infinity)).toBe(300_000);
    expect(retry(10 ** 12)).toBe(86_400_000);
  });
});
