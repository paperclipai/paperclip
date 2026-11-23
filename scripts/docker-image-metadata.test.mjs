import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { imageMetadata } from "./docker-image-metadata.mjs";

const sha = "a".repeat(40);
const base = { repository: "paperclipai/paperclip", sha, ref: "refs/heads/master", event: "push", lastMigration: "0000_fixture.sql", migrationCount: "1", created: "2000-01-01T00:00:00.000Z" };
const tags = options => imageMetadata({ ...base, ...options }).tags.map(tag => tag.split(":")[1]);

test("master keeps immutable short/full SHA tags without moving a release channel", () => {
  assert.deepEqual(tags({}), [`sha-${sha}`, `sha-${sha.slice(0, 7)}`]);
  assert.deepEqual(tags({ event: "workflow_dispatch" }), [`sha-${sha.slice(0, 7)}`]);
  assert.deepEqual(tags({ repository: "example/fork" }), [`sha-${sha.slice(0, 7)}`]);
});

test("release lanes keep their existing tags and stable semver aliases", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    assert.deepEqual(tags({ ref: "refs/tags/v1.2.3", event }), ["1.2.3", "1.2", "latest", "sha-aaaaaaa"]);
    assert.deepEqual(tags({ ref: "refs/tags/v1.2.3-rc.1+build", event }), ["1.2.3-rc.1", "latest", "sha-aaaaaaa"]);
    assert.deepEqual(tags({ ref: "refs/tags/beta/v1.2.3-beta.1", event }), ["beta", "sha-aaaaaaa"]);
    assert.deepEqual(tags({ ref: "refs/tags/nightly/v1.2.3", event }), ["nightly", "sha-aaaaaaa"]);
    assert.deepEqual(tags({ ref: "refs/tags/canary/v1.2.3", event }), ["sha-aaaaaaa"]);
    for (const version of ["01.2.3", "1.2.3-01", "1.2.3-a..b"]) {
      assert.deepEqual(tags({ ref: `refs/tags/v${version}`, event }), ["latest", "sha-aaaaaaa"]);
    }
  }
});

test("OCI source, revision and migration labels come from the checkout inputs", () => {
  const metadata = imageMetadata(base);
  assert.equal(metadata.labels["org.opencontainers.image.source"], "https://github.com/paperclipai/paperclip");
  assert.equal(metadata.labels["org.opencontainers.image.revision"], sha);
  assert.equal(metadata.labels["io.github.paperclipai.schema.last-migration"], base.lastMigration);
  assert.equal(metadata.labels["io.github.paperclipai.schema.migration-count"], "1");
  for (const options of [{ sha: "main" }, { repository: "invalid\nrepo" }, { lastMigration: "x.sql\nINJECTED=1" }, { migrationCount: "1\nINJECTED=1" }]) {
    assert.throws(() => imageMetadata({ ...base, ...options }), /Invalid image metadata/);
  }
});

test("the CLI writes usable outputs without any GitHub credential", () => {
  const dir = mkdtempSync(join(tmpdir(), "docker-metadata-"));
  try {
    const output = join(dir, "outputs");
    const env = { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: base.repository, GITHUB_SHA: sha, GITHUB_REF: base.ref, GITHUB_EVENT_NAME: base.event,
      LAST_MIGRATION: base.lastMigration, MIGRATION_COUNT: base.migrationCount };
    execFileSync(process.execPath, [new URL("./docker-image-metadata.mjs", import.meta.url).pathname], { env });
    const text = readFileSync(output, "utf8");
    const json = JSON.parse(text.split("\n")[0].slice(5));
    assert.deepEqual(json.tags, tags({}).map(tag => `ghcr.io/paperclipai/paperclip:${tag}`));
    assert.equal(json.labels["org.opencontainers.image.licenses"], "MIT");
    assert.match(text, /labels<<[^\n]+\norg.opencontainers.image.created=/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("both workflow metadata steps use local inputs and the manifest consumes their explicit JSON output", () => {
  const workflow = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /docker\/metadata-action/);
  assert.equal(workflow.match(/run: node scripts\/docker-image-metadata.mjs/g)?.length, 2);
  assert.equal(workflow.match(/LAST_MIGRATION: \$\{\{ steps.schema.outputs.last \}\}/g)?.length, 2);
  assert.match(workflow, /DOCKER_METADATA_OUTPUT_JSON: \$\{\{ steps.meta.outputs.json \}\}/);
});

test("trusted release checks tolerate older checkouts and run each new test when present", () => {
  const workflow = readFileSync(new URL("../.github/workflows/pr-trusted.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Test release verify workflow wiring\n")[1].split("\n      - name:")[0];
  const script = step.split("        run: |\n")[1].replace(/^ {10}/gm, "");
  const baseline = ["./scripts/__tests__/release-verify-workflow.test.mjs", "./scripts/__tests__/eval-schedule-monitor.test.mjs",
    "./scripts/__tests__/prepare-runner-release-image.test.mjs", "./scripts/cloud-source-verification.test.mjs",
    "./scripts/cloud-readiness-runner-loss.test.mjs", "./scripts/standard-image-contract.test.mjs", "./scripts/reuse-canary-image.test.mjs"];
  const added = ["./scripts/github-actions-rate-limit.test.mjs", "./scripts/docker-image-metadata.test.mjs"];
  const dir = mkdtempSync(join(tmpdir(), "trusted-release-checks-"));
  try {
    mkdirSync(join(dir, "scripts/__tests__"), { recursive: true });
    for (const file of baseline) writeFileSync(join(dir, file), "");
    const output = join(dir, "selected.json"), capture = join(dir, "capture.mjs");
    writeFileSync(capture, `import { existsSync, writeFileSync } from "node:fs";
      const files = process.argv.slice(2);
      if (files.some(file => !existsSync(file))) process.exit(1);
      writeFileSync(process.env.CAPTURE_OUTPUT, JSON.stringify(files));`);
    for (const present of [[], added.slice(0, 1), added.slice(1), added]) {
      for (const file of added) rmSync(join(dir, file), { force: true });
      for (const file of present) writeFileSync(join(dir, file), "");
      execFileSync("bash", ["-euo", "pipefail", "-c", script], { cwd: dir,
        env: { ...process.env, CI_NODE_TEST: capture, CAPTURE_OUTPUT: output } });
      assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), [...baseline, ...present]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
