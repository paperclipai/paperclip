import { tooManyRequests } from '../errors.js';

/** Process-local limits match the process-local Git download pool and cache. */
export function createSkillSourceScanLimiter(now = Date.now) {
  const buckets = new Map<string, { active: number; scans: number[]; downloads: number[] }>();
  return (companyId: string, callerId: string) => {
    const current = now();
    for (const [key, bucket] of buckets) {
      bucket.scans = bucket.scans.filter(time => time > current - 60_000);
      bucket.downloads = bucket.downloads.filter(time => time > current - 60_000);
      if (!bucket.active && !bucket.scans.length && !bucket.downloads.length) buckets.delete(key);
    }
    const limits = [
      { key: `caller:${callerId}`, active: 1, scans: 30, downloads: 6 },
      { key: `company:${companyId}`, active: 2, scans: 60, downloads: 12 },
    ].map(limit => ({ ...limit, bucket: buckets.get(limit.key) ?? { active: 0, scans: [], downloads: [] } }));
    const reject = (message: string, retryAfterSeconds: number): never => {
      throw tooManyRequests(message, { code: 'skill_source_scan_limited', retryAfterSeconds });
    };
    for (const limit of limits) {
      if (limit.bucket.active >= limit.active) reject('A skill scan is already running for this account or company. Wait for it to finish and try again.', 5);
      if (limit.bucket.scans.length >= limit.scans) reject('Skill scan limit reached. Wait a minute and try again.', 60);
    }
    for (const limit of limits) {
      limit.bucket.active++;
      limit.bucket.scans.push(current);
      buckets.set(limit.key, limit.bucket);
    }
    let released = false;
    return {
      beforeDownload: () => {
        for (const limit of limits) {
          limit.bucket.downloads = limit.bucket.downloads.filter(time => time > now() - 60_000);
          if (limit.bucket.downloads.length >= limit.downloads) reject('Repository download limit reached. Wait a minute and try again.', 60);
        }
        for (const limit of limits) limit.bucket.downloads.push(now());
      },
      release: () => {
        if (released) return;
        released = true;
        for (const limit of limits) limit.bucket.active--;
      },
    };
  };
}
