import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Vitest stops each forks-pool worker with SIGTERM, which skips `exit`
// handlers. These checks run real suites under a private TMPDIR and require
// that no test home or workspace snapshot directory outlives the run, including
// when a file fails, times out or throws while it is imported.

const root = fileURLToPath(new URL("../../", import.meta.url));
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const api = fileURLToPath(new URL("../../node_modules/vitest/dist/index.js", import.meta.url));
const setup = path.join(root, "server/src/__tests__/setup-supertest.ts");
const RESIDUE = /^paperclip-(vitest-|workspace-baseline-|workspace-manifest-)/;

function removeTree(directory) {
  const makeWritable = (current) => {
    chmodSync(current, 0o700);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) makeWritable(path.join(current, entry.name));
    }
  };
  try { if (lstatSync(directory).isDirectory()) makeWritable(directory); } catch { /* already gone */ }
  rmSync(directory, { recursive: true, force: true });
}

function runVitestWithPrivateTmpdir(t, { cwd, args, timeout, tmp: sharedTmp }) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pc-temp-residue-")));
  t.after(() => removeTree(scratch));
  const tmp = sharedTmp ?? path.join(scratch, "tmp");
  if (!sharedTmp) mkdirSync(tmp);
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  // The server setup creates a private Codex home only when none is supplied.
  delete env.CODEX_HOME;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [vitest, "run", ...args(scratch)], { cwd, env, encoding: "utf8", timeout });
  const residue = readdirSync(tmp).filter((name) => RESIDUE.test(name)).sort();
  return { result, residue, tmp, output: `${result.error ?? ""}\n${result.stdout}\n${result.stderr}` };
}

test("server test setup removes its homes when files pass, fail, time out or fail to import", (t) => {
  const { result, residue, output } = runVitestWithPrivateTmpdir(t, {
    cwd: root,
    timeout: 120_000,
    args: (scratch) => {
      const directory = path.join(scratch, "suite");
      mkdirSync(directory);
      const files = {
        "pass.test.ts": `import { expect, it } from ${JSON.stringify(api)}; it("passes", () => expect(process.env.PAPERCLIP_HOME).toBeTruthy());`,
        "fail.test.ts": `import { expect, it } from ${JSON.stringify(api)}; it("fails", () => expect(1).toBe(2));`,
        "timeout.test.ts": `import { it } from ${JSON.stringify(api)}; it("times out", () => new Promise(() => {}), 200);`,
        "import-error.test.ts": `throw new Error("expected import failure");`,
      };
      for (const [name, source] of Object.entries(files)) writeFileSync(path.join(directory, name), source);
      const config = path.join(directory, "vitest.config.mjs");
      writeFileSync(config, `export default ${JSON.stringify({
        root: directory,
        test: { include: Object.keys(files), pool: "forks", isolate: true, maxWorkers: 1, setupFiles: [setup] },
      })};`);
      return ["--config", config];
    },
  });
  assert.equal(result.status, 1, output);
  assert.match(result.stdout + result.stderr, /expected import failure/);
  assert.deepEqual(residue, [], output);
});

test("an embedded Postgres suite whose setup times out still removes its cluster", (t) => {
  const helper = path.join(root, "packages/db/src/test-embedded-postgres.ts");
  let tmp;
  const run = (name, hookTimeout) => runVitestWithPrivateTmpdir(t, {
    cwd: root,
    timeout: 300_000,
    tmp,
    args: (scratch) => {
      const directory = path.join(scratch, `suite-${name}`);
      mkdirSync(directory);
      writeFileSync(path.join(directory, `${name}.test.ts`), `
        import { afterAll, beforeAll, it } from ${JSON.stringify(api)};
        import { startEmbeddedPostgresTestDatabase } from ${JSON.stringify(helper)};
        let database = null;
        beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-pg-${name}-"); }, ${hookTimeout});
        afterAll(async () => { await database?.cleanup(); });
        it("runs", () => {});
      `);
      const config = path.join(directory, "vitest.config.mjs");
      writeFileSync(config, `export default ${JSON.stringify({
        root: directory,
        test: { include: [`${name}.test.ts`], pool: "forks", isolate: true, maxWorkers: 1, hookTimeout: 120_000 },
      })};`);
      return ["--config", config];
    },
  });
  // Build the shared cluster template first, so the timed-out setup below
  // reaches the per-suite cluster rather than the one-time template build.
  const warm = run("warm", 120_000);
  tmp = warm.tmp;
  assert.equal(warm.result.status, 0, warm.output);
  const timedOut = run("hook-timeout", 300);
  assert.equal(timedOut.result.status, 1, timedOut.output);
  assert.match(timedOut.output, /Hook timed out/);
  assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith("paperclip-pg-")), [], timedOut.output);
});

test("sandbox runtime tests release the workspace snapshots they prepare", (t) => {
  const { result, residue, output } = runVitestWithPrivateTmpdir(t, {
    cwd: path.join(root, "packages/adapter-utils"),
    timeout: 300_000,
    args: () => [
      "src/sandbox-managed-runtime.test.ts",
      "--testTimeout", "60000",
      "-t", "handles an overlay source changed after the snapshot",
    ],
  });
  assert.equal(result.status, 0, output);
  assert.deepEqual(residue, [], output);
});
