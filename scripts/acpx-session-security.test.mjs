import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const { createFileSessionStore } = await import(
  process.env.ACPX_RUNTIME_PATH ?? "../packages/adapter-utils/node_modules/acpx/dist/runtime.js"
);

function syntheticRunJwt(runId) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ run_id: runId, sub: "synthetic" })}.synthetic_signature`;
}

function sessionRecord(token, id = "synthetic-record", lastUsedAt = "2026-01-01T00:00:00.000Z", closed = false) {
  return {
    acpxRecordId: id,
    acpSessionId: "synthetic-session",
    agentCommand: "synthetic-agent",
    cwd: "/synthetic",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt,
    lastSeq: 0,
    closed,
    messages: [],
    updated_at: "2026-01-01T00:00:00.000Z",
    acpx: {
      session_options: {
        model: "synthetic-model",
        env: { PAPERCLIP_API_KEY: token, ALTERNATE_AUTH: token, ORDINARY_FLAG: "kept" },
      },
      alternate_label: { nested: [`prefix ${token} suffix`] },
    },
  };
}

function hasRunJwt(value) {
  return JSON.stringify(value).match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)?.some((candidate) => {
    try {
      return Object.hasOwn(JSON.parse(Buffer.from(candidate.split(".")[1], "base64url")), "run_id");
    } catch {
      return false;
    }
  }) ?? false;
}

test("ACPX disk persistence removes run JWTs at every depth and uses current credentials on resume", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-security-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const oldToken = syntheticRunJwt("old-run");
  const currentToken = syntheticRunJwt("current-run");
  const store = createFileSessionStore({ stateDir, runtimeEnv: { PAPERCLIP_API_KEY: currentToken, ALTERNATE_AUTH: currentToken } });
  const record = sessionRecord(oldToken);
  await store.save(record);
  const persisted = JSON.parse(await readFile(join(stateDir, "sessions", "synthetic-record.json"), "utf8"));
  assert.equal(hasRunJwt(persisted), false);
  assert.equal(persisted.acpx.session_options.model, "synthetic-model");
  assert.equal(persisted.acpx.session_options.env.ORDINARY_FLAG, "kept");
  assert.equal(persisted.acpx.session_options.env.ALTERNATE_AUTH, undefined);
  const resumed = await store.load("synthetic-record");
  assert.equal(resumed.acpx.session_options.env.PAPERCLIP_API_KEY, currentToken);
  assert.equal(resumed.acpx.session_options.env.ALTERNATE_AUTH, currentToken);
  persisted.acpx.session_options.env.PAPERCLIP_API_KEY = oldToken;
  persisted.acpx.session_options.env.ALTERNATE_AUTH = oldToken;
  await writeFile(join(stateDir, "sessions", "synthetic-record.json"), JSON.stringify(persisted));
  const legacyResume = await store.load("synthetic-record");
  assert.equal(legacyResume.acpx.session_options.env.PAPERCLIP_API_KEY, currentToken);
  assert.equal(legacyResume.acpx.session_options.env.ALTERNATE_AUTH, currentToken);
  await store.save(legacyResume);
  assert.equal(hasRunJwt(JSON.parse(await readFile(join(stateDir, "sessions", "synthetic-record.json"), "utf8"))), false);
  const noOptions = JSON.parse(await readFile(join(stateDir, "sessions", "synthetic-record.json"), "utf8"));
  delete noOptions.acpx.session_options;
  await writeFile(join(stateDir, "sessions", "synthetic-record.json"), JSON.stringify(noOptions));
  assert.equal((await store.load("synthetic-record")).acpx.session_options.env.PAPERCLIP_API_KEY, currentToken);
});

test("ACPX retention prunes closed sessions by age and count while preserving active sessions", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-retention-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  await setup.save(sessionRecord("ordinary", "old", "2026-01-01T00:00:00.000Z", true));
  await setup.save(sessionRecord("ordinary", "recent", "2026-01-09T00:00:00.000Z", true));
  await setup.save(sessionRecord("ordinary", "newest", "2026-01-10T00:00:00.000Z", true));
  await setup.save(sessionRecord("ordinary", "active", "2026-01-01T00:00:00.000Z", false));
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 7, maxSessions: 2, scanLimit: 4, deleteLimit: 2 } });
  const result = await store.prune(Date.parse("2026-01-10T12:00:00.000Z"));
  assert.deepEqual(result, { scanned: 4, deleted: 2 });
  assert.equal(await store.load("old"), undefined);
  assert.equal(await store.load("recent"), undefined);
  assert.ok(await store.load("newest"));
  assert.ok(await store.load("active"));
});

test("ACPX pruning concurrent with a save preserves the new active record", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-retention-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1, maxSessions: 1, scanLimit: 8, deleteLimit: 8, sweepIntervalMs: 0 } });
  for (let i = 0; i < 20; i++) {
    const id = `race-${i}`;
    await setup.save(sessionRecord("ordinary", id, "2026-01-01T00:00:00.000Z", true));
    await Promise.all([
      store.prune(Date.parse("2026-01-10T00:00:00.000Z")),
      setup.save(sessionRecord("ordinary", id, "2026-01-10T00:00:00.000Z", false)),
    ]);
    assert.equal((await setup.load(id))?.closed, false);
  }
});

test("ACPX retention limits per-sweep reads and deletions", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-retention-bounds-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  for (let i = 0; i < 5; i++) await setup.save(sessionRecord("ordinary", `closed-${i}`, "2026-01-01T00:00:00.000Z", true));
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1, maxSessions: 1, scanLimit: 2, deleteLimit: 1 } });
  assert.deepEqual(await store.prune(Date.parse("2026-01-10T00:00:00.000Z")), { scanned: 2, deleted: 1 });
});


test("ACPX retention shares the deadline and cursor across new stores for one directory", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-retention-multistore-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  for (let i = 0; i < 5; i++) await setup.save(sessionRecord("ordinary", `stale-${i}`, "2026-01-01T00:00:00.000Z", true));
  const retention = { enabled: true, maxAgeDays: 1, maxSessions: 1, scanLimit: 1, deleteLimit: 1 };
  const start = Date.parse("2026-01-10T00:00:00.000Z");
  await writeFile(join(stateDir, "sessions.prune.lock"), JSON.stringify({ pid: 2147483647, nonce: "dead-owner" }));
  const first = createFileSessionStore({ stateDir, retention });
  const concurrent = createFileSessionStore({ stateDir, retention });
  const firstPass = await Promise.all([first.prune(start), concurrent.prune(start)]);
  assert.equal(firstPass.reduce((total, result) => total + result.scanned, 0), 1);
  assert.equal(firstPass.reduce((total, result) => total + result.deleted, 0), 1);
  const fresh = createFileSessionStore({ stateDir, retention });
  assert.deepEqual(await fresh.prune(start + 30_000), { scanned: 0, deleted: 0 });
  assert.deepEqual(await fresh.prune(start + 60_000), { scanned: 1, deleted: 1 });
  for (let i = 2; i < 8; i++) {
    const next = createFileSessionStore({ stateDir, retention });
    await next.prune(start + i * 60_000);
  }
  for (let i = 0; i < 5; i++) assert.equal(await setup.load(`stale-${i}`), undefined);
});


test("ACPX reclaims a stale lock when the PID has restarted", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-pid-reuse-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  await setup.save(sessionRecord("ordinary", "stale", "2026-01-01T00:00:00.000Z", true));
  await writeFile(join(stateDir, "sessions.prune.lock"), JSON.stringify({ pid: process.pid, processStart: "prior-process-start", nonce: "dead" }));
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1 } });
  assert.equal((await store.prune(Date.parse("2026-01-10T00:00:00.000Z"))).deleted, 1);
  assert.equal(await store.load("stale"), undefined);
});

test("ACPX recovers an interrupted reclaim guard", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-reclaim-restart-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  await setup.save(sessionRecord("ordinary", "stale", "2026-01-01T00:00:00.000Z", true));
  const dead = JSON.stringify({ pid: process.pid, processStart: "prior-process-start", nonce: "dead" });
  await writeFile(join(stateDir, "sessions.prune.lock"), dead);
  await writeFile(join(stateDir, "sessions.prune.lock.reclaim"), dead);
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1 } });
  assert.equal((await store.prune(Date.parse("2026-01-10T00:00:00.000Z"))).deleted, 1);
});

test("ACPX restores an active record claimed before a crash", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-claim-restart-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  await setup.save(sessionRecord("ordinary", "active-after-race", "2026-01-10T00:00:00.000Z", false));
  const file = join(stateDir, "sessions", "active-after-race.json");
  await rename(file, `${file}.${process.pid}.00000000-0000-4000-8000-000000000000.pruning`);
  const restarted = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1 } });
  assert.equal((await restarted.load("active-after-race"))?.closed, false);
  assert.equal((await setup.load("active-after-race"))?.closed, false);
});


test("ACPX restart sweep restores a claimed active record even before the next retention deadline", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-claim-deadline-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  await setup.save(sessionRecord("ordinary", "active-claimed", "2026-01-10T00:00:00.000Z", false));
  const file = join(stateDir, "sessions", "active-claimed.json");
  await rename(file, `${file}.${process.pid}.00000000-0000-4000-8000-000000000000.pruning`);
  const now = Date.parse("2026-01-10T00:00:00.000Z");
  await writeFile(join(stateDir, "sessions.prune-state.json"), JSON.stringify({ lastPruneAt: now, pruneOffset: 0 }));
  const restarted = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1 } });
  assert.deepEqual(await restarted.prune(now + 1000), { scanned: 0, deleted: 0 });
  assert.equal((await restarted.load("active-claimed"))?.closed, false);
});


test("ACPX load does not consume a claim owned by a live sweep", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-live-claim-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  await setup.save(sessionRecord("ordinary", "active-live-claim", "2026-01-10T00:00:00.000Z", false));
  const file = join(stateDir, "sessions", "active-live-claim.json");
  const claim = `${file}.${process.pid}.00000000-0000-4000-8000-000000000000.pruning`;
  await rename(file, claim);
  await writeFile(join(stateDir, "sessions.prune.lock"), JSON.stringify({ pid: process.pid, nonce: "live" }));
  assert.equal((await setup.load("active-live-claim"))?.closed, false);
  assert.ok((await readFile(claim, "utf8")).includes('"closed": false'));
  await rm(join(stateDir, "sessions.prune.lock"));
  const restarted = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1 } });
  await restarted.prune(Date.parse("2026-01-10T00:00:00.000Z"));
  assert.equal((await setup.load("active-live-claim"))?.closed, false);
});

test("ACPX stale-lock recovery leaves a live sweep's claim untouched", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux process-start identity fixture");
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-overlap-recovery-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  await setup.save(sessionRecord("ordinary", "live-sweep", "2026-01-10T00:00:00.000Z", false));
  const file = join(stateDir, "sessions", "live-sweep.json");
  const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const processStart = `${bootId}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
  const claim = `${file}.${process.pid}.${Buffer.from(processStart).toString("hex")}.00000000-0000-4000-8000-000000000000.pruning`;
  await rename(file, claim);
  await writeFile(join(stateDir, "sessions.prune.lock"), JSON.stringify({ pid: 2147483647, processStart: "dead", nonce: "old" }));
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1 } });
  await store.prune(Date.parse("2026-01-10T00:00:00.000Z"));
  assert.equal(JSON.parse(await readFile(claim, "utf8")).closed, false);
  assert.equal((await setup.load("live-sweep"))?.closed, false);
});

test("ACPX claim recovery advances past preserved conflicts", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux process-start identity fixture");
    return;
  }
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-claim-cursor-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  const deadOwner = `2147483647.${Buffer.from("prior-process-start").toString("hex")}.00000000-0000-4000-8000-000000000000.pruning`;
  for (const id of ["a", "b", "c", "z-active"]) {
    await setup.save(sessionRecord("ordinary", id, "2026-01-10T00:00:00.000Z", false));
    const file = join(stateDir, "sessions", `${id}.json`);
    if (id === "z-active") await rename(file, `${file}.${deadOwner}`);
    else await writeFile(`${file}.${deadOwner}`, await readFile(file));
  }
  const now = Date.parse("2026-01-10T00:00:00.000Z");
  await writeFile(join(stateDir, "sessions.prune-state.json"), JSON.stringify({ lastPruneAt: now, pruneOffset: 0 }));
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, scanLimit: 2 } });
  await store.prune(now + 1000);
  assert.equal(await readFile(join(stateDir, "sessions", "z-active.json"), "utf8").then(() => true, () => false), false);
  await store.prune(now + 2000);
  assert.equal(JSON.parse(await readFile(join(stateDir, "sessions", "z-active.json"), "utf8")).closed, false);
  assert.equal((await setup.load("z-active"))?.closed, false);
  assert.ok((await readdir(join(stateDir, "sessions"))).some((name) => name.startsWith("a.json.") && name.endsWith(".pruning")));
});

test("ACPX recovery cursor write preserves a newer sweep deadline", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-claim-state-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  await setup.save(sessionRecord("ordinary", "conflict", "2026-01-10T00:00:00.000Z", false));
  const file = join(stateDir, "sessions", "conflict.json");
  await writeFile(`${file}.2147483647.${Buffer.from("dead").toString("hex")}.00000000-0000-4000-8000-000000000000.pruning`, await readFile(file));
  const statePath = join(stateDir, "sessions.prune-state.json");
  const claimStatePath = join(stateDir, "sessions.prune-claim-state.json");
  const now = Date.parse("2026-01-10T00:00:00.000Z");
  await writeFile(statePath, JSON.stringify({ lastPruneAt: now, pruneOffset: 0 }));
  const newerState = { lastPruneAt: now + 60000, pruneOffset: 7 };
  const originalRename = fs.rename;
  t.after(() => { fs.rename = originalRename; });
  let injected = false;
  fs.rename = async (source, target) => {
    if (!injected && (target === statePath || target === claimStatePath)) {
      injected = true;
      await writeFile(statePath, JSON.stringify(newerState));
    }
    return originalRename(source, target);
  };
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, scanLimit: 1 } });
  await store.prune(now + 1000);
  assert.equal(injected, true);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), newerState);
  assert.equal(typeof JSON.parse(await readFile(claimStatePath, "utf8")).claimCursor, "string");
});

test("ACPX missing session returns undefined before any save", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-empty-load-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  assert.equal(await createFileSessionStore({ stateDir }).load("absent"), undefined);
});


test("ACPX keeps an active claim when another save fills its normal path", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "acpx-claim-conflict-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const setup = createFileSessionStore({ stateDir });
  const file = join(stateDir, "sessions", "claim-conflict.json");
  await setup.save(sessionRecord("ordinary", "claim-conflict", "2026-01-01T00:00:00.000Z", true));
  const originalRename = fs.rename;
  t.after(() => { fs.rename = originalRename; });
  fs.rename = async (source, target) => {
    if (source === file && String(target).endsWith(".pruning")) {
      await setup.save(sessionRecord("ordinary", "claim-conflict", "2026-01-10T00:00:00.000Z", false));
      await originalRename(source, target);
      await setup.save(sessionRecord("ordinary", "claim-conflict", "2026-01-11T00:00:00.000Z", true));
      return;
    }
    return originalRename(source, target);
  };
  const store = createFileSessionStore({ stateDir, retention: { enabled: true, maxAgeDays: 1 } });
  assert.equal((await store.prune(Date.parse("2026-01-10T00:00:00.000Z"))).deleted, 0);
  const claim = (await readdir(join(stateDir, "sessions"))).find((name) => name.endsWith(".pruning"));
  assert.ok(claim);
  assert.equal(JSON.parse(await readFile(join(stateDir, "sessions", claim), "utf8")).closed, false);
});
