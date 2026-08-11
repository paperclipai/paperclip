import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../provision-worktree.sh", import.meta.url).pathname;
const runtimeScript = new URL("../provision-worktree-runtime.sh", import.meta.url).pathname;

// Keep the PATH minimal so the fallback ladder is deterministic: node must be
// reachable, but a globally installed `paperclipai` must not shadow the paths
// under test.
const testPath = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(":");

const cleanupDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Writes a fake base workspace whose "tsx runner" is a plain node script, so
 * the provision script's health check and init call can be steered per test.
 *
 * helpExit: exit code for `... index.ts --help` (the health check boot).
 * initExit: exit code for `... index.ts worktree init ...`; on 0 the fake CLI
 *           writes a marker config so tests can tell CLI init from fallback.
 */
function makeBaseWorkspace({ helpExit, initExit, ensureExit = 0 }) {
  const baseCwd = makeTempDir("paperclip-provision-base-");
  const runnerPath = path.join(baseCwd, "cli", "node_modules", "tsx", "dist", "cli.mjs");
  const entryPath = path.join(baseCwd, "cli", "src", "index.ts");
  fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "// fake CLI entry\n");
  fs.writeFileSync(
    runnerPath,
    `
import fs from "node:fs";
const cliArgs = process.argv.slice(3);
fs.appendFileSync(${JSON.stringify(path.join(baseCwd, "cli-invocations.log"))}, JSON.stringify(cliArgs) + "\\n");
if (cliArgs.includes("--help")) {
  if (${helpExit} !== 0) console.error("ERR_MODULE_NOT_FOUND: drizzle-orm");
  process.exit(${helpExit});
}
if (cliArgs[0] === "worktree" && cliArgs[1] === "init") {
  if (${initExit} !== 0) {
    console.error("fake worktree init failure");
    process.exit(${initExit});
  }
  fs.mkdirSync(".paperclip", { recursive: true });
  fs.writeFileSync(".paperclip/config.json", JSON.stringify({ $meta: { source: "fake-cli" } }));
  fs.writeFileSync(".paperclip/.env", "PAPERCLIP_IN_WORKTREE=true\\n");
  process.exit(0);
}
if (cliArgs[0] === "worktree" && cliArgs[1] === "ensure-seeded") {
  if (${ensureExit} !== 0) {
    console.error("fake worktree ensure-seeded failure");
    process.exit(${ensureExit});
  }
  fs.rmSync(".paperclip/seed-pending", { force: true });
  fs.writeFileSync(".paperclip/seed-complete", "{}\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  return baseCwd;
}

function runProvision(baseCwd, { pathPrefix } = {}) {
  const worktreeCwd = makeTempDir("paperclip-provision-worktree-");
  const worktreesHome = makeTempDir("paperclip-provision-home-");
  const result = spawnSync("bash", [script], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: pathPrefix ? `${pathPrefix}:${testPath}` : testPath,
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
      PAPERCLIP_WORKSPACE_BRANCH: "feature/provision-test",
      PAPERCLIP_WORKTREES_DIR: worktreesHome,
      PAPERCLIP_HOME: path.join(worktreesHome, "no-such-instance-home"),
    },
  });
  return { result, worktreeCwd, worktreesHome };
}

function runRuntimeProvision(baseCwd, worktreeCwd) {
  const worktreesHome = makeTempDir("paperclip-provision-runtime-home-");
  return spawnSync("bash", [runtimeScript], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: testPath,
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
      PAPERCLIP_WORKSPACE_BRANCH: "feature/provision-runtime-test",
      PAPERCLIP_WORKTREES_DIR: worktreesHome,
      PAPERCLIP_HOME: path.join(worktreesHome, "no-such-instance-home"),
    },
  });
}

function readCliInvocations(baseCwd) {
  const logPath = path.join(baseCwd, "cli-invocations.log");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readWorktreeConfig(worktreeCwd) {
  const configPath = path.join(worktreeCwd, ".paperclip", "config.json");
  assert.ok(fs.existsSync(configPath), `expected ${configPath} to exist`);
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

test("uses the base CLI when its import graph boots", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const { result, worktreeCwd } = runProvision(baseCwd);

  assert.equal(result.status, 0, result.stderr);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "fake-cli");
  assert.ok(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));
  const initInvocation = readCliInvocations(baseCwd).find(
    (args) => args[0] === "worktree" && args[1] === "init",
  );
  assert.ok(
    initInvocation?.includes("--no-seed"),
    `expected --no-seed in ${JSON.stringify(initInvocation)}`,
  );
});

test("falls back to an isolated config when the base CLI cannot boot", () => {
  // Simulates the dangling pnpm symlink incident: the runner and entry files
  // exist, but booting the CLI fails ESM resolution. The base has no
  // package.json/pnpm-lock.yaml, so the repair install is not possible and the
  // script must degrade to the no-CLI fallback config instead of failing.
  const baseCwd = makeBaseWorkspace({ helpExit: 1, initExit: 0 });
  const { result, worktreeCwd, worktreesHome } = runProvision(baseCwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /writing isolated fallback config/);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "configure");
  const dataDir = config.database.embeddedPostgresDataDir;
  assert.ok(
    !path.relative(worktreesHome, dataDir).startsWith(".."),
    `expected ${dataDir} to live under ${worktreesHome}`,
  );
  const env = fs.readFileSync(path.join(worktreeCwd, ".paperclip", ".env"), "utf8");
  assert.match(env, /PAPERCLIP_IN_WORKTREE=true/);
  assert.ok(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));
});

test("repairs an unhealthy base install under the lock and then uses the CLI", (t) => {
  const hasTools = ["flock", "git"].every(
    (tool) => spawnSync("bash", ["-lc", `command -v ${tool}`], { env: { PATH: testPath } }).status === 0,
  );
  if (!hasTools) {
    t.skip("flock or git not available on this host");
    return;
  }

  // The CLI's health is controlled by a flag file, and a fake `pnpm install`
  // creates that flag — modeling a forced reinstall that relinks the store.
  const baseCwd = makeTempDir("paperclip-provision-repair-base-");
  const healthFlag = path.join(baseCwd, "cli-healthy.flag");
  const runnerPath = path.join(baseCwd, "cli", "node_modules", "tsx", "dist", "cli.mjs");
  const entryPath = path.join(baseCwd, "cli", "src", "index.ts");
  fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "// fake CLI entry\n");
  fs.writeFileSync(
    runnerPath,
    `
import fs from "node:fs";
const cliArgs = process.argv.slice(3);
if (cliArgs.includes("--help")) {
  process.exit(fs.existsSync(${JSON.stringify(healthFlag)}) ? 0 : 1);
}
if (cliArgs[0] === "worktree" && cliArgs[1] === "init") {
  fs.mkdirSync(".paperclip", { recursive: true });
  fs.writeFileSync(".paperclip/config.json", JSON.stringify({ $meta: { source: "fake-cli" } }));
  fs.writeFileSync(".paperclip/.env", "PAPERCLIP_IN_WORKTREE=true\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  fs.writeFileSync(path.join(baseCwd, "package.json"), "{}\n");
  fs.writeFileSync(path.join(baseCwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  spawnSync("git", ["init", "-q", baseCwd], { env: { PATH: testPath } });

  const fakeBin = makeTempDir("paperclip-provision-fakebin-");
  const installLog = path.join(baseCwd, "pnpm-invocations.log");
  fs.writeFileSync(
    path.join(fakeBin, "pnpm"),
    `#!/usr/bin/env bash
if [[ "$1" == "install" ]]; then
  echo "$@" >> ${JSON.stringify(installLog)}
  touch ${JSON.stringify(healthFlag)}
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  const { result, worktreeCwd } = runProvision(baseCwd, { pathPrefix: fakeBin });

  assert.equal(result.status, 0, result.stderr);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "fake-cli");
  const installs = fs.readFileSync(installLog, "utf8").trim().split("\n");
  assert.equal(installs.length, 1, `expected exactly one repair install, got: ${installs.join(" | ")}`);
  assert.match(installs[0], /--force/);
  assert.match(installs[0], /--frozen-lockfile/);
  assert.ok(
    fs.existsSync(path.join(baseCwd, ".git", "paperclip-provision-repair.lock")),
    "expected the repair lock file inside the resolved git dir",
  );
});

test("a failed CLI init fails provisioning instead of being masked as success", () => {
  // Regression test for the masked `return 0` after the init subshell: a CLI
  // that passes the health check but fails `worktree init` signals a real
  // problem, so the script must propagate the failure rather than report
  // success or write an unseeded fallback config over it.
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 3 });
  const { result, worktreeCwd } = runProvision(baseCwd);

  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /fake worktree init failure/);
  assert.ok(!fs.existsSync(path.join(worktreeCwd, ".paperclip", "config.json")));
});

test("runtime provisioning invokes ensure-seeded once and fast-exits after success", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-worktree-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "config.json"), "{}\n");
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "seed-pending"), "{}\n");

  const first = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-complete")));
  assert.ok(!fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));

  const ensureCallsAfterFirst = readCliInvocations(baseCwd)
    .filter((args) => args[0] === "worktree" && args[1] === "ensure-seeded");
  assert.equal(ensureCallsAfterFirst.length, 1);
  assert.ok(ensureCallsAfterFirst[0].includes("--config"));
  assert.ok(ensureCallsAfterFirst[0].includes("--from-config"));

  const second = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /already seeded; skipping/);
  const ensureCallsAfterSecond = readCliInvocations(baseCwd)
    .filter((args) => args[0] === "worktree" && args[1] === "ensure-seeded");
  assert.equal(ensureCallsAfterSecond.length, 1);
});

test("runtime provisioning leaves seed-pending in place when ensure-seeded fails", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0, ensureExit: 4 });
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-failure-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "config.json"), "{}\n");
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "seed-pending"), "{}\n");

  const result = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /fake worktree ensure-seeded failure/);
  assert.ok(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));
  assert.ok(!fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-complete")));
});
