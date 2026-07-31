import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../provision-worktree.sh", import.meta.url).pathname;

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
function makeBaseWorkspace({ helpExit, initExit }) {
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
process.exit(0);
`,
  );
  return baseCwd;
}

function runProvision(baseCwd) {
  const worktreeCwd = makeTempDir("paperclip-provision-worktree-");
  const worktreesHome = makeTempDir("paperclip-provision-home-");
  const result = spawnSync("bash", [script], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: testPath,
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
});

test("a failed CLI init falls through to the fallback config instead of reporting success", () => {
  // Regression test for the masked `return 0` after the init subshell: a CLI
  // that passes the health check but fails `worktree init` must not leave the
  // worktree with no config at all.
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 3 });
  const { result, worktreeCwd } = runProvision(baseCwd);

  assert.equal(result.status, 0, result.stderr);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "configure");
});
