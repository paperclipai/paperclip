import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

// e2e and the Runner package lane never run on master. Their weights come from
// PR-workflow runs of PRs that merged into master, pinned to the final head SHA.
// Logs are parsed as data; nothing from a run is executed.
export const repository = "paperclipai/paperclip";
export const repositoryId = 1170821064;
const api = `/repos/${repository}`;

export const runnerPackageRoot = "packages/paperclip-runner";
export const e2eManifest = "scripts/e2e-shard-durations.json";
export const runnerManifest = `${runnerPackageRoot}/scripts/vitest-lane-durations.json`;

export function validatePull(pull) {
  assert.equal(pull.base?.ref, "master");
  assert.equal(pull.base?.repo?.id, repositoryId);
  assert.ok(pull.merged_at, `PR #${pull.number} is not merged`);
  assert.match(pull.head?.sha ?? "", /^[a-f0-9]{40}$/);
  assert.match(pull.merge_commit_sha ?? "", /^[a-f0-9]{40}$/);
}

export function validatePrRun(run, pull) {
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.repository?.id, repositoryId);
  assert.equal(run.event, "pull_request");
  assert.equal(run.path, ".github/workflows/pr.yml");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  // A run of an earlier push measures code that never merged.
  assert.equal(run.head_sha, pull.head.sha);
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
}

export function e2eShardJob(name) {
  const match = /^ci \/ e2e shard \((\d+)\/(\d+)\)$/.exec(name);
  return match ? { index: Number(match[1]), count: Number(match[2]) } : null;
}

// Current: "ci / Verify Paperclip Runner (vitest package)".
// Planned: "ci / Verify Paperclip Runner (package (K/N))".
export function runnerPackageJob(name) {
  if (name === "ci / Verify Paperclip Runner (vitest package)") return { index: 1, count: 1 };
  const match = /^ci \/ Verify Paperclip Runner \(package \((\d+)\/(\d+)\)\)$/.exec(name);
  return match ? { index: Number(match[1]), count: Number(match[2]) } : null;
}

// Returns the jobs only when they form one complete, successful set of shards.
export function completeShardSet(jobs, classify) {
  const selected = jobs.map(job => ({ job, shard: classify(job.name) })).filter(item => item.shard);
  if (!selected.length) return null;
  const count = selected[0].shard.count;
  const indexes = new Set(selected.map(item => item.shard.index));
  if (selected.some(item => item.shard.count !== count || item.job.conclusion !== "success")) return null;
  if (indexes.size !== selected.length || indexes.size !== count) return null;
  for (let index = 1; index <= count; index++) if (!indexes.has(index)) return null;
  return selected.map(item => item.job);
}

function splitLogLine(raw) {
  const line = stripVTControlCharacters(raw).replace(/\r$/, "");
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z ?(.*)$/.exec(line);
  if (!match) return { time: null, text: line };
  const fraction = Number(`0.${match[2] ?? "0"}`);
  return { time: Date.parse(`${match[1]}Z`) + fraction * 1000, text: match[3] };
}

// A location outside a spec (e.g. smoke-lab.shared.ts) belongs to the shard's
// spec named after it. Several candidates are told apart by the suffix that the
// describe title repeats, e.g. "(P1-P4)" for smoke-lab-p1-p4.spec.ts.
export function attributeSpec(location, title, shardSpecs) {
  if (location.endsWith(".spec.ts")) {
    assert.ok(!shardSpecs || shardSpecs.includes(location), `${location} is not in this shard`);
    return location;
  }
  assert.ok(shardSpecs, `No shard spec list to attribute ${location}`);
  const directory = path.posix.dirname(location);
  const stem = path.posix.basename(location).replace(/(\.shared)?\.[cm]?[jt]sx?$/, "");
  const candidates = shardSpecs.filter(spec => path.posix.dirname(spec) === directory
    && path.posix.basename(spec).startsWith(`${stem}-`));
  if (candidates.length === 1) return candidates[0];
  const lower = title.toLowerCase();
  const named = candidates.filter(spec => lower.includes(path.posix.basename(spec).slice(stem.length + 1, -".spec.ts".length)));
  assert.equal(named.length, 1, `Cannot attribute ${location} (${title}) to one spec`);
  return named[0];
}

// The e2e lane runs one Playwright worker, so each gap between consecutive
// result lines is the finishing test's cost including fixtures and navigation.
// The first gap starts when Playwright reports "Running N tests".
export function parseE2eLog(log, inventory) {
  let shardSpecs = null, start = null, previous = null, expected = null, seen = 0;
  const totals = new Map();
  for (const raw of log.split("\n")) {
    const { time, text } = splitLogLine(raw);
    if (time === null || text.startsWith("[WebServer]")) continue;
    const specs = /^shard \d+\/\d+ specs: (.+)$/.exec(text);
    if (specs) {
      shardSpecs = specs[1].trim().split(/\s+/);
      continue;
    }
    const running = /^Running (\d+) tests? using (\d+) workers?\b/.exec(text);
    if (running) {
      assert.equal(start, null, "Expected one Playwright run per job");
      assert.equal(Number(running[2]), 1, "Gap attribution requires a single Playwright worker");
      expected = Number(running[1]);
      start = previous = time;
      continue;
    }
    if (start === null) continue;
    const result = /^\s*\S+\s+\d+\s+\[[^\]]+\]\s+›\s+(tests\/e2e\/[^\s:]+):\d+:\d+\s+›\s+(.*)$/.exec(text);
    if (!result) continue;
    assert.ok(!result[1].split("/").some(part => part === ".." || part === "."), result[1]);
    seen++;
    const spec = attributeSpec(result[1], result[2], shardSpecs);
    const gap = Math.max(0, time - previous);
    previous = time;
    totals.set(spec, (totals.get(spec) ?? 0) + gap);
  }
  assert.notEqual(start, null, "No Playwright run found");
  assert.equal(seen, expected, `Parsed ${seen} of ${expected} Playwright results`);
  const parsed = new Map();
  for (const [spec, ms] of totals) {
    assert.ok(ms <= 3_600_000, `${spec}: implausible ${ms}ms`);
    // Deleted or renamed specs still appear in older trusted runs.
    if (inventory.has(spec)) parsed.set(spec, { ms: Math.round(ms), complete: true });
  }
  return parsed;
}

// Vitest prints one line per file, relative to the package:
//  ✓ src/live/runnerd-codex-transport.test.ts (257 tests) 126679ms
// The value covers tests and hooks, not collection or setup.
export function parseRunnerLog(log, inventory) {
  const parsed = new Map();
  let expected = 0, seen = 0, summaries = 0;
  for (const raw of log.split("\n")) {
    const { text } = splitLogLine(raw);
    const summary = /^\s*Test Files\s+(?:\d+ failed \| )?(\d+) passed\b/.exec(text);
    if (summary) {
      summaries++;
      expected += Number(summary[1]);
      continue;
    }
    const match = /^\s*✓\s+(\S+\.test\.[cm]?[jt]sx?)\s+\(\d+ tests?[^)]*\)\s+(\d+)ms\s*$/.exec(text);
    if (!match) continue;
    assert.ok(!match[1].split("/").some(part => part === ".." || part === "." || part === ""), match[1]);
    assert.ok(!match[1].includes("\\"));
    seen++;
    const file = `${runnerPackageRoot}/${match[1]}`, ms = Number(match[2]);
    assert.ok(ms <= 3_600_000, `${file}: implausible ${ms}ms`);
    if (inventory.has(file)) parsed.set(file, { ms: Math.max(parsed.get(file)?.ms ?? 0, ms), complete: false });
  }
  assert.ok(summaries > 0, "No Vitest summary found");
  assert.equal(seen, expected, `Parsed ${seen} of ${expected} passed Vitest files`);
  return parsed;
}

// The Runner include globs, read as text so the refresh needs no installed
// dependencies. Tests assert the list stays non-empty and matches real files.
export function runnerIncludeGlobs(repoRoot = process.cwd()) {
  const config = readFileSync(path.join(repoRoot, runnerPackageRoot, "vitest.config.ts"), "utf8");
  const block = /\binclude:\s*\[([\s\S]*?)\]/.exec(config);
  assert.ok(block, "Runner vitest.config.ts has no include list");
  const globs = [...block[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.ok(globs.length > 0, "Runner include list is empty");
  return globs;
}

export function runnerInventory(repoRoot = process.cwd()) {
  const globs = runnerIncludeGlobs(repoRoot);
  const tracked = execFileSync("git", ["ls-files", "-z", "--", runnerPackageRoot], { cwd: repoRoot, encoding: "utf8" })
    .split("\0").filter(Boolean);
  return new Set(tracked.filter(file => {
    const relative = file.slice(runnerPackageRoot.length + 1);
    return globs.some(glob => path.matchesGlob(relative, glob));
  }));
}

export function isMergedIntoHead(sha, repoRoot = process.cwd()) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function keepLargest(target, parsed) {
  for (const [file, value] of parsed) {
    const previous = target.get(file);
    if (!previous || value.ms > previous.ms) target.set(file, value);
  }
}

// lanes: [{ name, classify(jobName) -> {index,count}|null, parse(log, inventory), inventory }]
// Returns { [lane]: { samples: Map[], sources: [] } } with at most maxRuns samples each.
export async function collectMergedPrSamples({ gh, lanes, maxRuns = 3, pullLimit = 40,
  isMerged = isMergedIntoHead, log = console.log } = {}) {
  const result = Object.fromEntries(lanes.map(lane => [lane.name, { samples: [], sources: [] }]));
  const pulls = await gh(`${api}/pulls?state=closed&base=master&sort=updated&direction=desc&per_page=${pullLimit}`);
  const merged = pulls.filter(pull => pull.merged_at).sort((a, b) => b.merged_at.localeCompare(a.merged_at));
  for (const pull of merged) {
    const pending = lanes.filter(lane => result[lane.name].samples.length < maxRuns);
    if (!pending.length) break;
    validatePull(pull);
    // Only measure code present in this checkout.
    if (!isMerged(pull.merge_commit_sha)) continue;
    const listed = await gh(`${api}/actions/workflows/pr.yml/runs?head_sha=${pull.head.sha}&event=pull_request&status=success&per_page=20`);
    const runs = listed.workflow_runs.filter(run => {
      try { validatePrRun(run, pull); return true; } catch { return false; }
    }).sort((a, b) => b.id - a.id);
    if (!runs.length) continue;
    const run = runs[0];
    const jobs = [];
    for (let page = 1; ; page++) {
      const response = await gh(`${api}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`);
      jobs.push(...response.jobs);
      if (response.jobs.length < 100) break;
    }
    for (const lane of pending) {
      const selected = completeShardSet(jobs, lane.classify);
      if (!selected) continue;
      const sample = new Map();
      try {
        for (const job of selected) {
          assert.equal(job.run_id, run.id);
          keepLargest(sample, lane.parse(await gh(`${api}/actions/jobs/${job.id}/logs`, false), lane.inventory));
        }
      } catch (error) {
        log(`::warning::${lane.name}: skipped run ${run.id} for PR #${pull.number}: ${error.message.split("\n")[0]}`);
        continue;
      }
      result[lane.name].samples.push(sample);
      result[lane.name].sources.push({ pull: pull.number, run: run.id, attempt: run.run_attempt, sha: run.head_sha, url: run.html_url });
    }
  }
  return result;
}
