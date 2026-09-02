import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Pins the diagnostics wiring of the Docker leg of the release smoke.
//
// The smoke itself only runs post-merge, against a published artifact, so its
// own failures are the only signal it ever sends — and for a long time that
// signal arrived with no container logs attached: the workflow learned the
// container's name from the harness's output, which a failing harness never
// produced, and the harness ran the container with `--rm` so stopping it
// deleted the logs anyway. These assertions keep both halves fixed.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "docker-onboard-smoke.sh");
const script = readFileSync(scriptPath, "utf8");
const workflow = readFileSync(
  join(repoRoot, ".github", "workflows", "release-smoke.yml"),
  "utf8",
);
const dockerJob = workflow.split(/^  smoke:$/m)[1] ?? "";

test("smoke script is executable and parses", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath]);
});

test("container name can be fixed by the caller", () => {
  // A name the caller chose is a name it still has when this script fails.
  assert.match(script, /CONTAINER_NAME="\$\{SMOKE_CONTAINER_NAME:-\$IMAGE_NAME\}"/);
  // And it is still sanitized into something Docker will accept.
  assert.match(script, /CONTAINER_NAME="\$\{CONTAINER_NAME\/\/\[\^a-zA-Z0-9_\.-\]\/-\}"/);
});

test("the container does not remove itself", () => {
  // `--rm` deletes the container the instant its process exits, so a crash
  // takes the logs with it before any cleanup can read them.
  assert.match(script, /^docker run -d \\$/m);
  assert.doesNotMatch(script, /docker run [^\n]*--rm/);
});

test("cleanup dumps the container logs before it tears the container down", () => {
  const cleanup = script.match(/^cleanup\(\) \{$[\s\S]*?^\}$/m)?.[0];
  assert.ok(cleanup, "cleanup() must exist");
  const dumpAt = cleanup.indexOf("dump_container_logs");
  const stopAt = cleanup.indexOf("docker stop");
  const removeAt = cleanup.indexOf("docker rm");
  assert.ok(dumpAt !== -1, "cleanup() must dump the container logs");
  assert.ok(stopAt !== -1, "cleanup() must still stop the container");
  assert.ok(
    removeAt !== -1,
    "cleanup() must remove the container now that it no longer removes itself",
  );
  assert.ok(
    dumpAt < stopAt && dumpAt < removeAt,
    "cleanup() must dump the logs before the teardown, or the teardown deletes them first",
  );
});

test("the log dump has a destination, and callers are told where it is", () => {
  assert.match(script, /SMOKE_LOG_FILE="\$\{SMOKE_LOG_FILE:-/);
  assert.match(script, /docker logs "\$CONTAINER_NAME" >"\$SMOKE_LOG_FILE"/);
  assert.match(script, /printf 'SMOKE_LOG_FILE=%q\\n' "\$SMOKE_LOG_FILE"/);
});

test("the log dump starts empty on every run", () => {
  // A caller that reuses one path — the default does, for a fixed container
  // name — must not be handed the previous run's logs as this run's evidence
  // when this run fails before a container exists.
  const truncateAt = script.search(/^\s*: >"\$SMOKE_LOG_FILE"/m);
  const dumpAt = script.indexOf("dump_container_logs() {");
  assert.ok(truncateAt !== -1, "the script must truncate SMOKE_LOG_FILE at startup");
  assert.ok(
    truncateAt < dumpAt,
    "the truncation must happen before anything can write the dump",
  );
});

test("workflow fixes the container name before the harness runs", () => {
  assert.match(dockerJob, /^    env:$/m);
  assert.match(dockerJob, /SMOKE_CONTAINER_NAME: release-smoke-onboard/);
  // Reading the name back out of the harness is the defect: a step that only
  // learns it on success cannot use it on failure.
  assert.doesNotMatch(dockerJob, /echo "SMOKE_CONTAINER_NAME=/);
  assert.match(dockerJob, /SMOKE_LOG_FILE="\$\{\{ runner\.temp \}\}\/docker-onboard-smoke\.log"/);
});

test("workflow captures and uploads the logs unconditionally", () => {
  const capture = dockerJob.split("- name: Capture Docker logs")[1] ?? "";
  assert.ok(capture, "the Capture Docker logs step must exist");
  assert.match(capture.split("- name:")[0], /if: always\(\)/);
  // No guard that a failing launch would leave false.
  assert.doesNotMatch(
    capture.split("- name:")[0],
    /\[\[ -n "\$\{SMOKE_CONTAINER_NAME:-\}" \]\]/,
  );

  const upload = dockerJob.split("- name: Upload diagnostics")[1] ?? "";
  assert.ok(upload, "the Upload diagnostics step must exist");
  assert.match(upload, /docker-onboard-smoke\.log/);
  assert.match(upload, /if-no-files-found: error/);
  // The metadata path is a literal, not a variable a failed launch never set.
  assert.doesNotMatch(upload, /\$\{\{ env\.SMOKE_METADATA_FILE \}\}/);
});
