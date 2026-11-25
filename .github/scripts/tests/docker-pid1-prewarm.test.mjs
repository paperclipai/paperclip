import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { imageMetadata } from "../../../scripts/docker-image-metadata.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const workflow = readFileSync(path.join(root, ".github/workflows/docker.yml"), "utf8");
const scriptPath = path.join(root, "scripts/docker-pid1-prewarm.sh");

function writeExecutable(file, content) {
  writeFileSync(file, content, "utf8");
  chmodSync(file, 0o755);
}

test("docker.yml gates base-layer pre-warm to AWS master builds and cleans up before and after the PID 1 probe", () => {
  const leg = workflow.split("\n  build-and-push:\n")[1].split("\n  publication_verification:\n")[0];
  const steps = leg.split(/\n(?=      - name: )/);
  const step = (name) => {
    const found = steps.find((item) => item.startsWith(`      - name: ${name}\n`));
    assert.ok(found, `missing step: ${name}`);
    return found;
  };
  const order = (name) => steps.indexOf(step(name));

  const prewarm = step("Pre-warm base layers for PID 1 probe");
  assert.match(prewarm, /if: steps\.promote\.outputs\.digest == '' && vars\.CORE_RELEASE_AWS_ENABLED == 'true' && github\.repository == 'paperclipai\/paperclip' && github\.repository_id == '1170821064' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/);
  assert.match(prewarm, /continue-on-error: true/);
  assert.match(prewarm, /run: bash scripts\/docker-pid1-prewarm\.sh start/);
  assert.ok(order("Docker meta") < order("Pre-warm base layers for PID 1 probe"));
  assert.ok(order("Pre-warm base layers for PID 1 probe") < order("Build and push by digest"));

  const probe = step("Verify PID 1 reaps orphaned processes");
  assert.match(probe, /bash scripts\/docker-pid1-prewarm\.sh stop 15/);
  assert.match(probe, /docker run --rm -i --pull always --platform "\$PLATFORM" "\$IMAGE_NAME@\$IMAGE_DIGEST" sh -s < scripts\/assert-orphan-reaping\.sh/);
  assert.ok(probe.indexOf("docker-pid1-prewarm.sh stop") < probe.indexOf("docker run --rm -i --pull always"));

  const cleanup = step("Stop background base-layer pre-warm if still running");
  assert.match(cleanup, /if: always\(\)/);
  assert.match(cleanup, /continue-on-error: true/);
  assert.match(cleanup, /run: bash scripts\/docker-pid1-prewarm\.sh stop 0/);
  assert.ok(order("Upload digest") < order("Stop background base-layer pre-warm if still running"));
});

test("docker-pid1-prewarm.sh finds the newest published ancestor image, pulls in background, and stops cleanly", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "docker-pid1-prewarm-"));
  try {
    const bin = path.join(tmp, "bin");
    const calls = path.join(tmp, "calls.log");
    const pidFile = path.join(tmp, "prewarm.pid");
    const logFile = path.join(tmp, "prewarm.log");
    spawnSync("mkdir", ["-p", bin]);

    const sha1 = "1".repeat(40);
    const sha2 = "2".repeat(40);
    const publishedMetadata = imageMetadata({
      repository: "paperclipai/paperclip",
      sha: sha2,
      ref: "refs/heads/master",
      event: "push",
      lastMigration: "0000_fixture.sql",
      migrationCount: "1",
      created: "2000-01-01T00:00:00.000Z",
    });
    const expectedTag = `ghcr.io/paperclipai/paperclip:sha-${sha2}`;
    assert.ok(
      publishedMetadata.tags.includes(expectedTag),
      `docker-image-metadata.mjs must publish ${expectedTag} for master pushes`,
    );
    writeExecutable(path.join(bin, "git"), `#!/usr/bin/env bash
case "$3" in
  HEAD~1^{commit}) echo "${sha1}" ;;
  HEAD~2^{commit}) echo "${sha2}" ;;
  *) exit 1 ;;
esac
`);
    writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash
echo "docker $*" >> "${calls}"
if [ "$1" = "manifest" ] && [ "$2" = "inspect" ]; then
  if [ "$3" = "ghcr.io/paperclipai/paperclip:sha-${sha2}" ]; then
    exit 0
  fi
  exit 1
fi
if [ "$1" = "pull" ]; then
  sleep 0.2
  exit 0
fi
exit 1
`);

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      IMAGE_NAME: "ghcr.io/paperclipai/paperclip",
      PLATFORM: "linux/amd64",
      PID_FILE: pidFile,
      LOG_FILE: logFile,
    };

    const started = spawnSync("bash", [scriptPath, "start"], { env, encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, new RegExp(`Pre-warming linux/amd64 base layers in background from ghcr\\.io/paperclipai/paperclip:sha-${sha2}`));
    assert.ok(existsSync(pidFile), "pidfile must be written when a published ancestor exists");

    const stopped = spawnSync("bash", [scriptPath, "stop", "5"], { env, encoding: "utf8" });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(existsSync(pidFile), false, "pidfile must be removed on stop");

    const recorded = readFileSync(calls, "utf8");
    assert.match(recorded, new RegExp(`docker manifest inspect ghcr\\.io/paperclipai/paperclip:sha-${sha1}`));
    assert.match(recorded, new RegExp(`docker manifest inspect ghcr\\.io/paperclipai/paperclip:sha-${sha2}`));
    assert.match(recorded, new RegExp(`docker pull --quiet --platform linux/amd64 ghcr\\.io/paperclipai/paperclip:sha-${sha2}`));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("docker-pid1-prewarm.sh skips cleanly when no recent ancestor image is published and never kills non-docker PIDs", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "docker-pid1-prewarm-skip-"));
  try {
    const bin = path.join(tmp, "bin");
    const pidFile = path.join(tmp, "prewarm.pid");
    const logFile = path.join(tmp, "prewarm.log");
    spawnSync("mkdir", ["-p", bin]);

    writeExecutable(path.join(bin, "git"), `#!/usr/bin/env bash
exit 1
`);
    writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash
exit 1
`);

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      IMAGE_NAME: "ghcr.io/paperclipai/paperclip",
      PLATFORM: "linux/arm64",
      PID_FILE: pidFile,
      LOG_FILE: logFile,
    };

    const started = spawnSync("bash", [scriptPath, "start"], { env, encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /skipping base-layer pre-warm/);
    assert.equal(existsSync(pidFile), false);

    // Writing our own node PID into pidFile must NOT kill this process.
    writeFileSync(pidFile, `${process.pid}\n`, "utf8");
    const stopped = spawnSync("bash", [scriptPath, "stop", "0"], { env, encoding: "utf8" });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(existsSync(pidFile), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("docker-pid1-prewarm.sh terminates a still-running docker pull when stop wait expires", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "docker-pid1-prewarm-kill-"));
  try {
    const bin = path.join(tmp, "bin");
    const pidFile = path.join(tmp, "prewarm.pid");
    const logFile = path.join(tmp, "prewarm.log");
    spawnSync("mkdir", ["-p", bin]);

    const sha1 = "a".repeat(40);
    writeExecutable(path.join(bin, "git"), `#!/usr/bin/env bash
echo "${sha1}"
`);
    writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash
if [ "$1" = "manifest" ]; then exit 0; fi
if [ "$1" = "pull" ]; then
  trap 'exit 0' TERM
  sleep 30 &
  wait $!
fi
exit 1
`);

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      IMAGE_NAME: "ghcr.io/paperclipai/paperclip",
      PLATFORM: "linux/amd64",
      PID_FILE: pidFile,
      LOG_FILE: logFile,
    };

    const started = spawnSync("bash", [scriptPath, "start"], { env, encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    try {
      const stopped = spawnSync("bash", [scriptPath, "stop", "0"], { env, encoding: "utf8" });
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /Stopping still-running base-layer pre-warm/);
      assert.equal(existsSync(pidFile), false);
      // Give the trapped shell a moment to exit, then confirm it is gone.
      let alive = true;
      for (let i = 0; i < 20; i++) {
        try { process.kill(pid, 0); } catch { alive = false; break; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      assert.equal(alive, false, "stop must terminate the background docker pull process");
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
