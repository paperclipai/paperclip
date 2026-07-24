import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeServingDrift,
  evaluateDrift,
  findServingService,
  resolveInstanceRoot,
  resolveLiveTree,
  resolveServingCommit,
} from "./live-service.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeRegistry(records) {
  const home = mkdtempSync(path.join(os.tmpdir(), "pc-live-service-"));
  const env = { PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: "default" };
  const registryDir = path.join(resolveInstanceRoot(env), "runtime-services");
  mkdirSync(registryDir, { recursive: true });
  for (const [name, record] of Object.entries(records)) {
    writeFileSync(path.join(registryDir, `${name}.json`), JSON.stringify(record));
  }
  return env;
}

/**
 * The whole point of this module is that it can be trusted from a git hook,
 * where the TS resolver is not importable -- so it re-derives the instance root
 * by hand. This test is what stops that copy from drifting: it drives the real
 * resolver and demands the same answer.
 */
function findTsxCli() {
  // pnpm does not hoist tsx to the root; the repo's own scripts reach into
  // cli/node_modules for it.
  const candidates = [
    path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "server", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

test("resolveInstanceRoot agrees with the shared TypeScript resolver", (t) => {
  const tsxCli = findTsxCli();

  // A checkout with no `pnpm install` cannot load the TS resolver at all. Skip
  // loudly rather than assert nothing: the drift this test exists to catch is
  // real, so a silent pass would be worse than no test.
  if (!tsxCli) {
    t.skip("tsx is not installed in this checkout -- run `pnpm install` to run the parity check");
    return;
  }

  const probe = path.join(mkdtempSync(path.join(os.tmpdir(), "pc-parity-")), "probe.ts");
  writeFileSync(
    probe,
    `import { resolvePaperclipInstanceRoot } from ${JSON.stringify(
      path.join(repoRoot, "packages", "shared", "src", "home-paths.ts"),
    )};\nprocess.stdout.write(resolvePaperclipInstanceRoot());\n`,
  );

  const env = { ...process.env, PAPERCLIP_HOME: "/tmp/pc-parity-home", PAPERCLIP_INSTANCE_ID: "someinstance" };
  const fromShared = execFileSync("node", [tsxCli, probe], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  assert.equal(fromShared, "/tmp/pc-parity-home/instances/someinstance");
  assert.equal(resolveInstanceRoot(env), fromShared);
});

test("defaults to ~/.paperclip/instances/default", () => {
  assert.equal(
    resolveInstanceRoot({}),
    path.join(os.homedir(), ".paperclip", "instances", "default"),
  );
});

test("returns null when no server has ever registered", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "pc-live-service-empty-"));
  assert.equal(findServingService({ PAPERCLIP_HOME: home }), null);
});

test("reports the cwd of the process that is actually serving", () => {
  const env = makeRegistry({
    live: {
      profileKind: "paperclip-dev",
      serviceKey: "live",
      cwd: "/Users/annica/paperclip-live",
      pid: process.pid, // alive by construction
      port: 3100,
      url: "http://127.0.0.1:3100",
      startedAt: "2026-07-14T12:00:00.000Z",
    },
  });

  assert.equal(findServingService(env).cwd, "/Users/annica/paperclip-live");
});

test("ignores a stale record whose process is gone", () => {
  // A server that died without deregistering must not keep claiming to be prod:
  // that is how a guard ends up protecting a tree nothing is serving from.
  const env = makeRegistry({
    dead: {
      profileKind: "paperclip-dev",
      cwd: "/Users/annica/Paperclip",
      pid: 2 ** 30, // no such process
      startedAt: "2026-07-14T12:00:00.000Z",
    },
  });

  assert.equal(findServingService(env), null);
});

test("ignores services that are not the control plane", () => {
  const env = makeRegistry({
    web: {
      profileKind: "workspace-runtime",
      cwd: "/tmp/some-preview-server",
      pid: process.pid,
      startedAt: "2026-07-14T12:00:00.000Z",
    },
  });

  assert.equal(findServingService(env), null);
});

test("when two servers are registered, the newest owns the port", () => {
  const env = makeRegistry({
    old: {
      profileKind: "paperclip-dev",
      cwd: "/Users/annica/Paperclip",
      pid: process.pid,
      startedAt: "2026-06-18T04:30:29.469Z",
    },
    new: {
      profileKind: "paperclip-dev",
      cwd: "/Users/annica/paperclip-live",
      pid: process.pid,
      startedAt: "2026-07-14T13:00:00.000Z",
    },
  });

  assert.equal(findServingService(env).cwd, "/Users/annica/paperclip-live");
});

test("a torn registry file does not take the guard down with it", () => {
  const env = makeRegistry({
    good: {
      profileKind: "paperclip-dev",
      cwd: "/Users/annica/paperclip-live",
      pid: process.pid,
      startedAt: "2026-07-14T13:00:00.000Z",
    },
  });
  const registryDir = path.join(resolveInstanceRoot(env), "runtime-services");
  writeFileSync(path.join(registryDir, "torn.json"), "{ not json");

  assert.equal(findServingService(env).cwd, "/Users/annica/paperclip-live");
});

test("falls back to the main worktree when nothing is serving", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "pc-live-service-down-"));
  const resolved = resolveLiveTree(repoRoot, { PAPERCLIP_HOME: home });

  assert.equal(resolved.source, "main-worktree-fallback");
  assert.equal(resolved.service, null);
  // Conservative: with the server down we still name a tree rather than none.
  assert.ok(resolved.tree.length > 0);
});

// --- LOOA-389: serving-tree drift ---------------------------------------

const GRACE_MS = 30 * 60 * 1000;

test("evaluateDrift: a tree level with master is not stale", () => {
  const d = evaluateDrift({ behindBy: 0, oldestUndeployedAtMs: 1, now: 1e12, graceMs: GRACE_MS });
  assert.equal(d.behindBy, 0);
  assert.equal(d.stale, false);
  assert.equal(d.driftAgeMs, null);
});

test("evaluateDrift: behind but inside the grace window is behind, not stale", () => {
  const now = 2_000_000;
  const d = evaluateDrift({ behindBy: 3, oldestUndeployedAtMs: now - 60_000, now, graceMs: GRACE_MS });
  assert.equal(d.behindBy, 3);
  assert.equal(d.stale, false);
  assert.equal(d.driftAgeMs, 60_000);
});

test("evaluateDrift: behind past the grace window is stale", () => {
  const now = 10_000_000;
  const d = evaluateDrift({ behindBy: 2, oldestUndeployedAtMs: now - GRACE_MS - 1, now, graceMs: GRACE_MS });
  assert.equal(d.behindBy, 2);
  assert.equal(d.stale, true);
  assert.ok(d.driftAgeMs >= GRACE_MS);
});

test("evaluateDrift: graceMs=0 means any behind tree with a known age is immediately stale", () => {
  // The `Number(env) || default` trap: 0 is a legitimate "no grace" setting.
  const now = 5_000_000;
  const d = evaluateDrift({ behindBy: 1, oldestUndeployedAtMs: now - 1, now, graceMs: 0 });
  assert.equal(d.stale, true);
  assert.equal(d.graceMs, 0);
});

test("evaluateDrift: behind with an unknown age is not paged (stale=false)", () => {
  // We know it is behind but cannot age it -- do not cry wolf on a commit that
  // may have merged seconds ago; `behindBy` still surfaces the drift.
  const d = evaluateDrift({ behindBy: 5, oldestUndeployedAtMs: null, now: 1e12, graceMs: GRACE_MS });
  assert.equal(d.behindBy, 5);
  assert.equal(d.stale, false);
  assert.equal(d.driftAgeMs, null);
});

function gitIn(cwd, args, extraEnv) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Build an "origin" repo at master=c2 and a "live" clone reset back to c1, so
// the live tree is exactly one reviewed-but-undeployed commit behind. This is
// the induced drift LOOA-389's acceptance demands we observe, not assert.
function makeDriftRepos(c2Date) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pc-drift-"));
  const origin = path.join(root, "origin");
  const live = path.join(root, "live");
  mkdirSync(origin, { recursive: true });
  gitIn(origin, ["init", "-q", "-b", "master"]);
  gitIn(origin, ["config", "user.email", "t@example.com"]);
  gitIn(origin, ["config", "user.name", "Test"]);
  writeFileSync(path.join(origin, "a.txt"), "1");
  gitIn(origin, ["add", "-A"]);
  gitIn(origin, ["commit", "-q", "-m", "c1"], {
    GIT_AUTHOR_DATE: "2026-07-15T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-07-15T00:00:00Z",
  });
  writeFileSync(path.join(origin, "a.txt"), "2");
  gitIn(origin, ["add", "-A"]);
  gitIn(origin, ["commit", "-q", "-m", "c2"], {
    GIT_AUTHOR_DATE: c2Date,
    GIT_COMMITTER_DATE: c2Date,
  });
  gitIn(root, ["clone", "-q", origin, live]);
  gitIn(live, ["config", "user.email", "t@example.com"]);
  gitIn(live, ["config", "user.name", "Test"]);
  gitIn(live, ["reset", "--hard", "-q", "HEAD~1"]); // HEAD -> c1, behind origin/master by 1
  return { live };
}

test("resolveServingCommit reports the live tree's HEAD and branch", () => {
  const { live } = makeDriftRepos("2026-07-15T00:30:00Z");
  const serving = resolveServingCommit(live);
  assert.ok(serving);
  assert.match(serving.head, /^[0-9a-f]{40}$/);
  assert.equal(serving.branch, "master");
});

test("resolveServingCommit returns null outside a git checkout", () => {
  const notARepo = mkdtempSync(path.join(os.tmpdir(), "pc-not-a-repo-"));
  assert.equal(resolveServingCommit(notARepo), null);
});

test("computeServingDrift observes a real one-commit-behind tree (past grace = stale)", () => {
  const c2 = "2026-07-15T00:00:00Z";
  const { live } = makeDriftRepos(c2);
  const now = Date.parse("2026-07-15T02:00:00Z"); // 2h after the undeployed commit
  const drift = computeServingDrift(live, { fetch: true, graceMs: GRACE_MS, now });

  assert.equal(drift.available, true);
  assert.equal(drift.base, "FETCH_HEAD"); // the fetch succeeded against the local origin
  assert.equal(drift.behindBy, 1);
  assert.equal(drift.stale, true);
  assert.equal(drift.oldestUndeployedAtMs, Date.parse(c2));
  assert.ok(drift.driftAgeMs >= GRACE_MS);
});

test("computeServingDrift: the same behind tree is not stale inside the grace window", () => {
  const c2 = "2026-07-15T00:00:00Z";
  const { live } = makeDriftRepos(c2);
  const now = Date.parse("2026-07-15T00:01:00Z"); // 1m after -- a normal merge->deploy gap
  const drift = computeServingDrift(live, { fetch: true, graceMs: GRACE_MS, now });

  assert.equal(drift.behindBy, 1);
  assert.equal(drift.stale, false);
});

test("computeServingDrift: a tree level with master is up to date", () => {
  const { live } = makeDriftRepos("2026-07-15T00:30:00Z");
  gitIn(live, ["merge", "--ff-only", "-q", "origin/master"]); // deploy it
  const drift = computeServingDrift(live, { fetch: true, graceMs: GRACE_MS, now: Date.now() });

  assert.equal(drift.available, true);
  assert.equal(drift.behindBy, 0);
  assert.equal(drift.stale, false);
});
