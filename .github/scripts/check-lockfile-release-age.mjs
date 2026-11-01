#!/usr/bin/env node
/**
 * check-lockfile-release-age.mjs
 * Decides whether the lockfile bot may merge a refreshed pnpm-lock.yaml without review.
 * Every package version that the refresh adds must be published on npm for at least
 * the minimum age. A version that is too new, or that cannot be verified, holds the
 * PR for a human.
 *
 * Exports: parseLockfilePackages(text), addedPackageVersions(baseText, headText),
 *          checkReleaseAge(entries, { fetchPublishTime, now, minAgeMs, concurrency })
 *
 * CLI: node check-lockfile-release-age.mjs --base <file> --head <file> --min-age-days <n>
 *      Writes `eligible=true|false` to GITHUB_OUTPUT and a Markdown report to --report.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// Every 2-space-indented line in `packages:` is an entry key. Keys can contain
// colons (URL and git dependencies), so match up to the final colon.
const PACKAGE_KEY = /^ {2}(\S.*):\s*$/;
const RESOLUTION = /^ {4}resolution: (.+?)\s*$/;
// A registry tarball is locked by integrity alone. A tarball URL, git repo or
// directory resolution names its own source and needs a human.
const REGISTRY_RESOLUTION = /^\{integrity: [^,{}]+\}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Maps each key of the lockfile's top-level `packages:` section to its resolution. */
export function parseLockfilePackages(text) {
  const packages = new Map();
  let inPackages = false;
  let key = null;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = line.trimEnd() === 'packages:';
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const keyMatch = PACKAGE_KEY.exec(line);
    if (keyMatch) {
      key = keyMatch[1].replace(/^'(.*)'$/, '$1').replace(/\(.*$/, '');
      packages.set(key, '');
      continue;
    }
    const resolutionMatch = key && RESOLUTION.exec(line);
    if (resolutionMatch) packages.set(key, resolutionMatch[1]);
  }
  return packages;
}

export function splitPackageKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { name: key, version: '' };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/** Package entries in headText that baseText lacks or resolves differently. */
export function addedPackageVersions(baseText, headText) {
  const base = parseLockfilePackages(baseText);
  return [...parseLockfilePackages(headText)]
    .filter(([key, resolution]) => base.get(key) !== resolution)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, resolution]) => ({ key, ...splitPackageKey(key), resolution }));
}

export async function fetchNpmPublishTime(name, version, fetchImpl = fetch) {
  const res = await fetchImpl(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const doc = await res.json();
  const published = doc.time?.[version];
  return published ? new Date(published) : null;
}

/**
 * Checks each added version. Fails closed: a lookup error, a missing publish time or a
 * non-registry version holds the merge.
 */
export async function checkReleaseAge(entries, {
  fetchPublishTime = fetchNpmPublishTime,
  now = new Date(),
  minAgeMs,
  concurrency = 8,
}) {
  const held = [];
  const queue = [...entries];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const reason = await holdReason(entry, fetchPublishTime, now, minAgeMs);
      if (reason) held.push({ ...entry, reason });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  held.sort((a, b) => a.key.localeCompare(b.key));
  return { eligible: held.length === 0, checked: entries.length, held };
}

async function holdReason({ name, version, resolution }, fetchPublishTime, now, minAgeMs) {
  if (!SEMVER.test(version)) return 'not a registry version';
  if (!REGISTRY_RESOLUTION.test(resolution ?? '')) return `not a registry resolution: ${resolution || 'missing'}`;
  let published;
  try {
    published = await fetchPublishTime(name, version);
  } catch (error) {
    return `registry lookup failed: ${error.message}`;
  }
  if (!published || Number.isNaN(published.getTime())) return 'no publish time on npm';
  const ageMs = now.getTime() - published.getTime();
  if (ageMs < minAgeMs) {
    return `published ${published.toISOString()} (${(ageMs / DAY_MS).toFixed(1)} days ago)`;
  }
  return null;
}

export function formatReport(result, minAgeDays) {
  const lines = ['<!-- lockfile-release-age -->'];
  if (result.eligible) {
    lines.push(`All ${result.checked} added package versions are at least ${minAgeDays} days old. The lockfile bot merges this PR.`);
  } else {
    lines.push(
      `The lockfile bot did not merge this PR. These added package versions are newer than ${minAgeDays} days or could not be verified:`,
      '',
      ...result.held.map(({ key, reason }) => `- \`${key}\`: ${reason}`),
      '',
      'A maintainer can review and merge this PR. If no one does, the daily refresh tries again and merges it when every version is old enough.',
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      'min-age-days': { type: 'string' },
      report: { type: 'string' },
    },
  });
  const minAgeDays = Number(values['min-age-days']);
  if (!values.base || !values.head || !Number.isFinite(minAgeDays) || minAgeDays < 0) {
    console.error('Usage: check-lockfile-release-age.mjs --base <file> --head <file> --min-age-days <n> [--report <file>]');
    process.exit(2);
  }

  const entries = addedPackageVersions(readFileSync(values.base, 'utf8'), readFileSync(values.head, 'utf8'));
  const result = await checkReleaseAge(entries, { minAgeMs: minAgeDays * DAY_MS });
  const report = formatReport(result, minAgeDays);
  console.log(report);
  if (values.report) writeFileSync(values.report, report);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${result.eligible}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
