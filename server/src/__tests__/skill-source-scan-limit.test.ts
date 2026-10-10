import { describe, expect, it } from 'vitest';
import { createSkillSourceScanLimiter } from '../services/skill-source-scan-limit.js';

describe('skill source scan limits', () => {
  it('keeps one caller from taking both download slots across companies and releases once', () => {
    const limit = createSkillSourceScanLimiter();
    const alice = limit('one', 'alice');
    expect(() => limit('two', 'alice')).toThrow('already running');
    const bob = limit('one', 'bob');
    expect(() => limit('one', 'charlie')).toThrow('already running');
    alice.release(); alice.release();
    const next = limit('one', 'alice');
    expect(() => limit('one', 'alice')).toThrow('already running');
    next.release(); bob.release();
  });

  it('bounds repeated cache hits, restores quotas after a minute, and keeps active leases', () => {
    let now = 0;
    const limit = createSkillSourceScanLimiter(() => now);
    for (let i = 0; i < 30; i++) limit('company', 'alice').release();
    expect(() => limit('company', 'alice')).toThrow('scan limit');
    now = 60_000;
    const active = limit('company', 'alice');
    now += 60_000;
    expect(() => limit('other', 'alice')).toThrow('already running');
    active.release();
    limit('company', 'alice').release();
  });

  it('bounds company requests across different callers without charging denied requests', () => {
    const limit = createSkillSourceScanLimiter(() => 0);
    for (let i = 0; i < 60; i++) limit('company', `user-${i}`).release();
    expect(() => limit('company', 'new-user')).toThrow('scan limit');
    limit('other', 'new-user').release();
  });

  it('limits repeated downloads separately from cached scans and counts failed attempts', () => {
    let now = 0;
    const limit = createSkillSourceScanLimiter(() => now);
    for (let i = 0; i < 6; i++) {
      const lease = limit('company', 'alice');
      lease.beforeDownload(); lease.release();
    }
    const cached = limit('company', 'alice');
    expect(() => cached.beforeDownload()).toThrow('download limit');
    cached.release();
    for (let i = 0; i < 6; i++) {
      const lease = limit('company', `user-${i}`);
      lease.beforeDownload(); lease.release();
    }
    const companyLimited = limit('company', 'new-user');
    expect(() => companyLimited.beforeDownload()).toThrow('download limit');
    companyLimited.release();
    now = 60_000;
    const retry = limit('company', 'alice');
    retry.beforeDownload(); retry.release();
  });
});
