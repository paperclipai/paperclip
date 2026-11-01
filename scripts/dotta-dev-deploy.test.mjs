import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployScript = path.join(repoRoot, "scripts", "dotta-dev-deploy.sh");

function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeExecutable(file, body) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function setupFixture({ backupMode = "success" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "dotta-dev-deploy-test-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const scratch = path.join(root, "scratch");
  const eventLog = path.join(root, "events.log");
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(scratch, { recursive: true });

  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(path.join(repo, "source.txt"), "train source\n");
  run("git", ["init", "-b", "master"], repo);
  run("git", ["config", "user.email", "test@example.com"], repo);
  run("git", ["config", "user.name", "Test"], repo);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "base"], repo);
  run("git", ["switch", "-c", "dev/dotta"], repo);
  writeFileSync(path.join(repo, "source.txt"), "assembled train source\n");
  run("git", ["add", "source.txt"], repo);
  run("git", ["commit", "-m", "merge train riders"], repo);
  const sourceCommit = run("git", ["rev-parse", "HEAD"], repo);
  const baseCommit = run("git", ["rev-parse", "HEAD^"], repo);

  const backupBody = backupMode === "fail"
    ? `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'backup\\n' >> "$EVENT_LOG"\nexit 7\n`
    : backupMode === "missing"
      ? `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'backup\\n' >> "$EVENT_LOG"\n`
      : `#!/usr/bin/env bash
set -euo pipefail
printf 'backup\\n' >> "$EVENT_LOG"
backup_dir=''
prefix=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) backup_dir="$2"; shift 2 ;;
    --filename-prefix) prefix="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$backup_dir"
printf 'fresh backup\\n' > "$backup_dir/$prefix-20990101T000000.sql.gz"
`;
  writeExecutable(path.join(repo, "scripts", "backup-db.sh"), backupBody);

  writeExecutable(path.join(bin, "pnpm"), `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$EVENT_LOG"
if [[ " $* " == *" build "* ]]; then
  mkdir -p server/dist
  printf 'built\\n' > server/dist/index.js
fi
`);

  const manifest = {
    schemaVersion: 1,
    generatedBy: "scripts/dotta-dev-train.sh",
    repository: "paperclipai/paperclip",
    branch: "dev/dotta",
    baseMasterSha: baseCommit,
    trainCommitSha: sourceCommit,
    generatedAt: "2099-01-01T00:00:00Z",
    dryRun: true,
    included: [
      { number: 17, headSha: sourceCommit, title: "First rider", migrations: false },
      { number: 42, headSha: sourceCommit, title: "Migration rider", migrations: true },
    ],
    skipped: [],
  };
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestHash = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");

  const appDir = path.join(scratch, "app");
  const stageDir = path.join(scratch, "stage");
  const backupDir = path.join(scratch, "backups");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, "old.txt"), "old app\n");

  return {
    root,
    repo,
    bin,
    scratch,
    eventLog,
    sourceCommit,
    manifestPath,
    manifestHash,
    appDir,
    stageDir,
    backupDir,
  };
}

function deployArgs(fixture) {
  return [
    deployScript,
    "--dry-run",
    "--source-ref", "dev/dotta",
    "--manifest", fixture.manifestPath,
    "--app-dir", fixture.appDir,
    "--stage-dir", fixture.stageDir,
    "--backup-dir", fixture.backupDir,
  ];
}

function runDeploy(fixture, env = {}) {
  return spawnSync("bash", deployArgs(fixture), {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      EVENT_LOG: fixture.eventLog,
      ...env,
    },
  });
}

test("live restart intent is written only after the candidate swap", () => {
  const source = readFileSync(deployScript, "utf8");
  const candidateMove = source.indexOf('mv -- "$stage_dir" "$app_dir"');
  const restartIntent = source.indexOf("pnpm --filter @paperclipai/server exec tsx ../scripts/request-hot-restart.ts");
  const serviceRestart = source.indexOf('systemctl restart "$LIVE_SERVICE"', restartIntent);

  assert.notEqual(candidateMove, -1);
  assert.notEqual(restartIntent, -1);
  assert.notEqual(serviceRestart, -1);
  assert.ok(candidateMove < restartIntent, "the swap must finish before the restart marker is written");
  assert.ok(restartIntent < serviceRestart, "the restart marker must exist before systemd restarts the service");
});

test("scratch deploy backs up first, builds dev/dotta, swaps, and stamps the manifest identity", () => {
  const fixture = setupFixture();
  const result = runDeploy(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(fixture.eventLog, "utf8").trim(), [
    "backup",
    "pnpm install --frozen-lockfile --force --prod=false",
    "pnpm build",
  ].join("\n"));
  assert.equal(readFileSync(path.join(fixture.appDir, "source.txt"), "utf8"), "assembled train source\n");
  assert.equal(readFileSync(path.join(fixture.appDir, "server/dist/index.js"), "utf8"), "built\n");

  const expectedVersion = `dotta-dev.prs-17-42.manifest-sha256-${fixture.manifestHash}.git-${fixture.sourceCommit.slice(0, 12)}`;
  assert.equal(readFileSync(path.join(fixture.appDir, ".paperclip-build-version"), "utf8").trim(), expectedVersion);
  assert.equal(
    createHash("sha256").update(readFileSync(path.join(fixture.appDir, ".paperclip-dotta-dev-manifest.json"))).digest("hex"),
    fixture.manifestHash,
  );
  assert.match(result.stdout, /\[1\/4\] Backing up the live database/);
  assert.match(result.stdout, /\[2\/4\] Building dev\/dotta/);
  assert.match(result.stdout, /\[3\/4\] Swapping the staged application/);
  assert.match(result.stdout, /\[4\/4\] Running the post-swap smoke check/);
  assert.match(result.stdout, /Scratch smoke passed\. No service was restarted\./);

  const previousApps = readdirSync(fixture.scratch).filter((name) => name.startsWith("app-prev-dotta-dev-"));
  assert.equal(previousApps.length, 1);
  assert.equal(readFileSync(path.join(fixture.scratch, previousApps[0], "old.txt"), "utf8"), "old app\n");
});

test("backup failure stops before validation, build, or swap", () => {
  const fixture = setupFixture({ backupMode: "fail" });
  writeFileSync(fixture.manifestPath, "not json\n");
  const result = runDeploy(fixture);

  assert.equal(result.status, 7);
  assert.equal(readFileSync(fixture.eventLog, "utf8"), "backup\n");
  assert.equal(readFileSync(path.join(fixture.appDir, "old.txt"), "utf8"), "old app\n");
  assert.equal(readdirSync(fixture.scratch).some((name) => name.startsWith("app-prev-dotta-dev-")), false);
});

test("live mode rejects a local train ref before invoking backup", () => {
  const fixture = setupFixture();
  const result = spawnSync("bash", [deployScript, "--source-ref", "dev/dotta"], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      EVENT_LOG: fixture.eventLog,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live deploys require --source-ref origin\/dev\/dotta/);
  assert.equal(readdirSync(fixture.root).includes("events.log"), false);
});

test("a successful backup command without a fresh backup artifact is rejected", () => {
  const fixture = setupFixture({ backupMode: "missing" });
  const result = runDeploy(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /produced no fresh non-empty dotta-dev-deploy backup/);
  assert.equal(readFileSync(fixture.eventLog, "utf8"), "backup\n");
  assert.equal(readFileSync(path.join(fixture.appDir, "old.txt"), "utf8"), "old app\n");
});

test("manifest validation happens only after a fresh backup", () => {
  const fixture = setupFixture();
  writeFileSync(fixture.manifestPath, "not json\n");
  const result = runDeploy(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest does not match/);
  assert.equal(readFileSync(fixture.eventLog, "utf8"), "backup\n");
  assert.equal(readFileSync(path.join(fixture.appDir, "old.txt"), "utf8"), "old app\n");
});

test("a stale manifest cannot label a newer train commit", () => {
  const fixture = setupFixture();
  writeFileSync(path.join(fixture.repo, "source.txt"), "newer train source\n");
  run("git", ["add", "source.txt"], fixture.repo);
  run("git", ["commit", "-m", "rebuild train"], fixture.repo);

  const result = runDeploy(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest trainCommitSha does not match dev\/dotta/);
  assert.equal(readFileSync(fixture.eventLog, "utf8"), "backup\n");
  assert.equal(readFileSync(path.join(fixture.appDir, "old.txt"), "utf8"), "old app\n");
});

test("dry-run refuses the live application directory before invoking backup", () => {
  const fixture = setupFixture();
  const args = deployArgs(fixture);
  const appIndex = args.indexOf("--app-dir") + 1;
  args[appIndex] = "/srv/paperclip/app";
  const result = spawnSync("bash", args, {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      EVENT_LOG: fixture.eventLog,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refuses to use the live application directory/);
  assert.equal(readdirSync(fixture.root).includes("events.log"), false);
});

test("dry-run rejects nested application, stage, and backup paths before invoking backup", () => {
  const fixture = setupFixture();
  const args = deployArgs(fixture);
  const stageIndex = args.indexOf("--stage-dir") + 1;
  args[stageIndex] = path.join(fixture.appDir, "stage");
  const result = spawnSync("bash", args, {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      EVENT_LOG: fixture.eventLog,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not contain each other/);
  assert.equal(readdirSync(fixture.root).includes("events.log"), false);
  assert.equal(readFileSync(path.join(fixture.appDir, "old.txt"), "utf8"), "old app\n");
});

test("a failed candidate move restores the previous application", () => {
  const fixture = setupFixture();
  writeExecutable(path.join(fixture.bin, "mv"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${2:-}" == "\${FAIL_MV_SOURCE:-}" ]]; then
  exit 23
fi
exec /usr/bin/mv "$@"
`);

  const result = runDeploy(fixture, { FAIL_MV_SOURCE: fixture.stageDir });

  assert.equal(result.status, 23);
  assert.match(result.stderr, /restoring .*app-prev-dotta-dev/);
  assert.equal(readFileSync(path.join(fixture.appDir, "old.txt"), "utf8"), "old app\n");
  assert.equal(readdirSync(fixture.scratch).some((name) => name.startsWith("app-prev-dotta-dev-")), false);
  assert.equal(readFileSync(path.join(fixture.stageDir, "source.txt"), "utf8"), "assembled train source\n");
});
