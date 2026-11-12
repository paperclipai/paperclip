import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";


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

function runVitestWithPrivateTmpdir(t, { cwd, args, timeout, tmp: sharedTmp, env: extraEnv = {} }) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pc-temp-residue-")));
  t.after(() => removeTree(scratch));
  const tmp = sharedTmp ?? path.join(scratch, "tmp");
  if (!sharedTmp) mkdirSync(tmp);
  const env = { ...process.env, ...extraEnv, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
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

function runEmbeddedPostgresSuite(t, name, { startMs, stopFails }) {
  const helper = path.join(root, "packages/db/src/test-embedded-postgres.ts");
  const client = path.join(root, "packages/db/src/client.ts");
  let markers;
  const run = runVitestWithPrivateTmpdir(t, {
    cwd: root,
    timeout: 120_000,
    env: { PAPERCLIP_TEST_POSTGRES_TEMPLATE: "0" },
    args: (scratch) => {
      const directory = path.join(scratch, `suite-${name}`);
      markers = path.join(scratch, "markers");
      mkdirSync(directory);
      mkdirSync(markers);
      writeFileSync(path.join(directory, `${name}.test.ts`), `
        import fs from "node:fs";
        import path from "node:path";
        import { beforeAll, it, vi } from ${JSON.stringify(api)};
        vi.doMock(${JSON.stringify(client)}, () => ({
          applyPendingMigrations: async () => {},
          closeRegisteredClients: async () => {},
          ensurePostgresDatabase: async () => {},
        }));
        const { __setEmbeddedPostgresCtorProviderForTests, startEmbeddedPostgresTestDatabase } = await import(${JSON.stringify(helper)});
        const mark = (file, text = "") => fs.writeFileSync(path.join(${JSON.stringify(markers)}, file), text);
        class FakePostgres {
          constructor(options) { mark("data-dir", options.databaseDir); }
          async initialise() {}
          async start() { await new Promise((resolve) => setTimeout(resolve, ${startMs})); mark("started"); }
          async stop() {
            mark("stop-called", fs.existsSync(path.join(${JSON.stringify(markers)}, "started")) ? "after-start" : "before-start");
            if (${stopFails}) throw new Error("injected stop failure");
          }
        }
        __setEmbeddedPostgresCtorProviderForTests(async () => FakePostgres);
        beforeAll(async () => { await startEmbeddedPostgresTestDatabase("paperclip-pg-${name}-"); }, ${startMs > 0 ? 50 : 10_000});
        it("runs", () => {});
      `);
      const config = path.join(directory, "vitest.config.mjs");
      writeFileSync(config, `export default ${JSON.stringify({
        root: directory,
        test: { include: [`${name}.test.ts`], pool: "forks", isolate: true, maxWorkers: 1 },
      })};`);
      return ["--config", config];
    },
  });
  const read = (file) => { try { return readFileSync(path.join(markers, file), "utf8"); } catch { return null; } };
  const clusters = readdirSync(run.tmp).filter((entry) => entry.startsWith(`paperclip-pg-${name}-`));
  return { ...run, read, clusters };
}

test("an embedded Postgres suite whose setup times out during startup still removes its cluster", (t) => {
  const run = runEmbeddedPostgresSuite(t, "hook-timeout", { startMs: 300, stopFails: false });
  assert.equal(run.result.status, 1, run.output);
  assert.match(run.output, /Hook timed out/);
  assert.equal(run.read("stop-called"), "after-start", run.output);
  assert.ok(run.read("data-dir"), run.output);
  assert.deepEqual(run.clusters, [], run.output);
});

test("an embedded Postgres cluster that fails to stop keeps its directory", (t) => {
  const run = runEmbeddedPostgresSuite(t, "stop-failure", { startMs: 0, stopFails: true });
  assert.equal(run.read("stop-called"), "after-start", run.output);
  assert.equal(run.clusters.length, 1, run.output);
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
