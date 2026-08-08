import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lifecycleScript = path.join(repoRoot, "scripts", "e2e-install-lifecycle.sh");
const migrationScript = path.join(repoRoot, "scripts", "e2e-update-migrations.sh");
const systemdDriver = path.join(repoRoot, "scripts", "run-install-e2e-systemd-docker.sh");

test("install acceptance shell harnesses have valid syntax", () => {
  for (const script of [lifecycleScript, migrationScript, systemdDriver]) {
    const result = spawnSync("bash", ["-n", script], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `${path.basename(script)}\n${result.stderr}`);
  }
});

test("package commands expose both native systemd acceptance lanes", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["test:install-e2e"], "./scripts/e2e-install-lifecycle.sh");
  assert.equal(packageJson.scripts["test:update-migrations-e2e"], "./scripts/e2e-update-migrations.sh");
  assert.equal(
    packageJson.scripts["test:install-e2e-systemd-docker"],
    "./scripts/run-install-e2e-systemd-docker.sh all",
  );

  const driver = readFileSync(systemdDriver, "utf8");
  assert.match(driver, /lifecycle\|migration\|all/);
  assert.match(driver, /run_one lifecycle/);
  assert.match(driver, /run_one migration/);
  assert.match(driver, /install-e2e-systemd\.Dockerfile/);
});

test("systemd lifecycle asserts every service acceptance invariant", () => {
  const source = readFileSync(lifecycleScript, "utf8");
  for (const marker of [
    "explicit service install is idempotent and leaves the service started",
    "crash-killed service respawned",
    "login-session restart with linger",
    "foreground run refused while service is active",
    "live local CLI-agent run reached running state",
    "adoptedRunIds",
    "adopted live run remains protected from orphan reaping",
    "service logs readable",
    "uninstall leaves no service loaded or active",
  ]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("systemd hot restart preserves children and orders embedded database shutdown", () => {
  const serviceManager = readFileSync(path.join(repoRoot, "cli", "src", "services", "service-manager.ts"), "utf8");
  const server = readFileSync(path.join(repoRoot, "server", "src", "index.ts"), "utf8");
  assert.match(serviceManager, /KillMode=process/);
  assert.match(server, /loadWithoutCoordinatedShutdownSignalHooks/);
  assert.match(server, /loadEmbeddedPostgresCtor/);
});

test("cross-version migration harness cleans failed installs and exposes base backup errors", () => {
  const source = readFileSync(migrationScript, "utf8");
  const cleanup = source.match(/cleanup\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
  assert.ok(cleanup, "expected cleanup function");
  assert.match(cleanup, /shim service stop/);
  assert.match(cleanup, /shim service uninstall/);
  assert.match(cleanup, /shim uninstall/);
  assert.match(source, /BASE_BACKUP_OUTPUT/);
  assert.match(source, /shim db:backup/);
  assert.doesNotMatch(source, /shim db-backup/);
  assert.doesNotMatch(source, /dump_text[^\n]*\| grep -q/);
  assert.match(source, /restarted service reports the updated payload version/);
  assert.match(source, /service logs are readable after update/);
});

test("cross-version refs are required before the harness writes files", () => {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PAPERCLIP_") && !name.startsWith("E2E_UPDATE_")),
  );
  for (const testCase of [
    { env: {}, missing: "E2E_UPDATE_BASE_REF" },
    { env: { E2E_UPDATE_BASE_REF: "test/base" }, missing: "E2E_UPDATE_NEXT_REF" },
  ]) {
    const testHome = mkdtempSync(path.join(os.tmpdir(), "paperclip-update-migrations-"));
    try {
      const result = spawnSync("bash", [migrationScript], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...cleanEnv, HOME: testHome, ...testCase.env },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${testCase.missing} is required`));
      assert.deepEqual(readdirSync(testHome), [], "validation must precede side effects");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  }
});
