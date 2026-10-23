import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import test, { after, before } from "node:test";

// Integration tests for scripts/restore-swap-db.sh against a throwaway
// PostgreSQL container. The swap is two `ALTER DATABASE ... RENAME` statements
// run in one transaction, so the interesting cases are the ones in between: a
// session lost after the first rename, a stray connection that would block a
// rename, and a deployment already stranded by an earlier hand-typed attempt.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "restore-swap-db.sh");
const image = process.env.RESTORE_SWAP_TEST_IMAGE ?? "postgres:17-alpine";
const container = `restore-swap-test-${process.pid}`;

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

const psqlArgv = ["docker", "exec", "-i", container, "psql", "-U", "paperclip", "-v", "ON_ERROR_STOP=1"];

function sql(db, statement) {
  return execFileSync(
    psqlArgv[0],
    [...psqlArgv.slice(1), "-d", db, "-Atqc", statement],
    { encoding: "utf8" },
  ).trim();
}

function databases() {
  return sql("postgres", "select datname from pg_database where datname like 'paperclip%' order by 1")
    .split("\n")
    .filter(Boolean);
}

function resetDatabases() {
  for (const db of databases()) {
    sql("postgres", `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${db}' and pid <> pg_backend_pid()`);
    sql("postgres", `drop database if exists "${db}"`);
  }
}

function createWithMarker(db, marker) {
  sql("postgres", `create database "${db}"`);
  sql(db, `create table marker(v text); insert into marker values ('${marker}')`);
}

function marker(db) {
  return sql(db, "select v from marker");
}

function runSwap(args, env = {}) {
  const res = spawnSync("bash", [scriptPath, ...args, "--", ...psqlArgv], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

before(async () => {
  if (!dockerAvailable) return;
  execFileSync("docker", [
    "run", "-d", "--name", container,
    "-e", "POSTGRES_USER=paperclip", "-e", "POSTGRES_DB=paperclip", "-e", "POSTGRES_PASSWORD=x",
    image,
  ], { stdio: "ignore" });
  for (let i = 0; i < 120; i += 1) {
    const ok = spawnSync("docker", [
      "exec", container, "psql", "-U", "paperclip", "-d", "paperclip", "-h", "127.0.0.1", "-Atqc", "select 1",
    ], { stdio: "ignore" }).status === 0;
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${image} never accepted a TCP connection`);
});

after(() => {
  if (!dockerAvailable) return;
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
});

test("script is executable and parses", () => {
  execFileSync("bash", ["-n", scriptPath]);
});

test("happy path: restored becomes live, live becomes prior, restored name is gone", { skip: !dockerAvailable && "docker unavailable" }, () => {
  resetDatabases();
  createWithMarker("paperclip", "old");
  createWithMarker("paperclip_restored", "new");

  const { status, out } = runSwap([]);
  assert.equal(status, 0, out);
  assert.deepEqual(databases(), ["paperclip", "paperclip_prior"]);
  assert.equal(marker("paperclip"), "new");
  assert.equal(marker("paperclip_prior"), "old");
  assert.match(out, /SWAP COMPLETE/);
});

test("a stray connection on the restored database is terminated, not fatal", { skip: !dockerAvailable && "docker unavailable" }, () => {
  resetDatabases();
  createWithMarker("paperclip", "old");
  createWithMarker("paperclip_restored", "new");
  // A psql left open from the verify step is the usual reason the second
  // rename fails. Hold one open for the duration of the swap.
  execFileSync("docker", [
    "exec", "-d", container, "psql", "-U", "paperclip", "-d", "paperclip_restored", "-c", "select pg_sleep(120)",
  ]);
  for (let i = 0; i < 50; i += 1) {
    const n = sql("postgres", "select count(*) from pg_stat_activity where datname = 'paperclip_restored'");
    if (Number(n) > 0) break;
    execFileSync("sleep", ["0.1"]);
  }

  const { status, out } = runSwap([]);
  assert.equal(status, 0, out);
  assert.match(out, /terminated 1 connection/);
  assert.deepEqual(databases(), ["paperclip", "paperclip_prior"]);
  assert.equal(marker("paperclip"), "new");
});

test("session lost between the two renames: nothing is renamed", { skip: !dockerAvailable && "docker unavailable" }, () => {
  resetDatabases();
  createWithMarker("paperclip", "old");
  createWithMarker("paperclip_restored", "new");

  // The fault hook kills the swap's own server session after the first rename
  // and before the second — SSH loss or a killed client at the worst moment.
  // No client-side cleanup runs; the server rolls the transaction back.
  const { status, out } = runSwap([], { RESTORE_SWAP_TEST_FAULT: "between-renames" });
  assert.notEqual(status, 0, out);
  assert.match(out, /did not commit, so nothing was renamed/);
  assert.deepEqual(databases(), ["paperclip", "paperclip_restored"]);
  assert.equal(marker("paperclip"), "old");
  assert.equal(marker("paperclip_restored"), "new");
});

test("a deployment stranded by an earlier attempt is recognised, and --rollback repairs it", { skip: !dockerAvailable && "docker unavailable" }, () => {
  resetDatabases();
  createWithMarker("paperclip_prior", "old");
  createWithMarker("paperclip_restored", "new");

  const swap = runSwap([]);
  assert.notEqual(swap.status, 0, swap.out);
  assert.match(swap.out, /no database named paperclip/);
  assert.match(swap.out, /--rollback/);
  assert.deepEqual(databases(), ["paperclip_prior", "paperclip_restored"]);

  const rollback = runSwap(["--rollback"]);
  assert.equal(rollback.status, 0, rollback.out);
  assert.deepEqual(databases(), ["paperclip", "paperclip_restored"]);
  assert.equal(marker("paperclip"), "old");
});

test("refuses to overwrite a prior copy left by an earlier swap", { skip: !dockerAvailable && "docker unavailable" }, () => {
  resetDatabases();
  createWithMarker("paperclip", "live");
  createWithMarker("paperclip_restored", "new");
  createWithMarker("paperclip_prior", "older");

  const { status, out } = runSwap([]);
  assert.notEqual(status, 0, out);
  assert.match(out, /paperclip_prior already exists/);
  assert.deepEqual(databases(), ["paperclip", "paperclip_prior", "paperclip_restored"]);
  assert.equal(marker("paperclip"), "live");
});

test("refuses when the restored database is missing, and touches nothing", { skip: !dockerAvailable && "docker unavailable" }, () => {
  resetDatabases();
  createWithMarker("paperclip", "live");

  const { status, out } = runSwap([]);
  assert.notEqual(status, 0, out);
  assert.match(out, /no database named paperclip_restored/);
  assert.deepEqual(databases(), ["paperclip"]);
});

test("database names are configurable", { skip: !dockerAvailable && "docker unavailable" }, () => {
  resetDatabases();
  createWithMarker("paperclip_a", "old");
  createWithMarker("paperclip_b", "new");

  const { status, out } = runSwap(["--live", "paperclip_a", "--restored", "paperclip_b", "--prior", "paperclip_c"]);
  assert.equal(status, 0, out);
  assert.deepEqual(databases(), ["paperclip_a", "paperclip_c"]);
  assert.equal(marker("paperclip_a"), "new");
  assert.equal(marker("paperclip_c"), "old");
});
