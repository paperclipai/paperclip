import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "publish.sh");
const tempDirs = new Set();

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createSite(name = "paperclip-page-test") {
  const siteDir = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirs.add(siteDir);
  writeFileSync(join(siteDir, "index.html"), "<!doctype html><title>Paperclip</title>\n");
  return siteDir;
}

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function writeState(siteDir, state) {
  mkdirSync(join(siteDir, ".paperclip-page"), { recursive: true });
  writeFileSync(join(siteDir, ".paperclip-page", "state.json"), `${JSON.stringify(state)}\n`);
}

function runPublish(args, env = {}) {
  try {
    return {
      output: execFileSync("bash", [scriptPath, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PAPERCLIP_PAGE_BUCKET: "paperclip-pages-test",
          PAPERCLIP_PAGE_BASE_URL: "https://pages.example.test/",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      status: 0,
    };
  } catch (error) {
    return {
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      status: error.status ?? 1,
    };
  }
}

test("publish helper stays executable", () => {
  assert.equal(statSync(scriptPath).mode & 0o111, 0o111);
});

test("dry run validates and prints the planned target without requiring AWS", () => {
  const result = runPublish([
    createSite(),
    "--slug",
    "demo-page",
    "--dry-run",
  ]);

  assert.equal(result.status, 0);
  assert.match(result.output, /^paperclip-page dry run$/m);
  assert.match(result.output, /^mode: publish$/m);
  assert.match(result.output, /^bucket: paperclip-pages-test$/m);
  assert.match(result.output, /^prefix: demo-page\/$/m);
  assert.match(result.output, /^url: https:\/\/pages\.example\.test\/demo-page\/$/m);
});

test("dry run normalizes a safe default prefix", () => {
  const result = runPublish(
    [createSite(), "--slug", "demo-page", "--dry-run"],
    { PAPERCLIP_PAGE_DEFAULT_PREFIX: "/reports/launches/" },
  );

  assert.equal(result.status, 0);
  assert.match(result.output, /^prefix: reports\/launches\/demo-page\/$/m);
  assert.match(result.output, /^url: https:\/\/pages\.example\.test\/reports\/launches\/demo-page\/$/m);
});

test("dry run update requires matching local ownership state", () => {
  const siteDir = createSite();
  const missingState = runPublish([siteDir, "--slug", "demo-page", "--update", "--dry-run"]);

  assert.notEqual(missingState.status, 0);
  assert.match(missingState.output, /requires ownership state/);

  writeState(siteDir, {
    bucket: "paperclip-pages-test",
    prefix: "demo-page/",
  });

  const result = runPublish([siteDir, "--slug", "demo-page", "--update", "--dry-run"]);

  assert.equal(result.status, 0);
  assert.match(result.output, /^mode: update$/m);
});

test("rejects nested slugs", () => {
  const result = runPublish([createSite(), "--slug", "nested/path", "--dry-run"]);

  assert.notEqual(result.status, 0);
  assert.match(result.output, /slug must be one path segment/);
});

test("rejects hidden files in the source tree", () => {
  const siteDir = createSite();
  mkdirSync(join(siteDir, "assets"));
  writeFileSync(join(siteDir, "assets", ".secret"), "do not publish\n");

  const result = runPublish([siteDir, "--slug", "demo-page", "--dry-run"]);

  assert.notEqual(result.status, 0);
  assert.match(result.output, /hidden files and dot paths are not allowed/);
});

test("live publish writes state before URL verification", () => {
  const siteDir = createSite();
  const binDir = mkdtempSync(join(tmpdir(), "paperclip-page-bin-"));
  tempDirs.add(binDir);

  writeExecutable(
    join(binDir, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" == "--region" || "$1" == "--profile" ]]; do
  shift 2
done
if [[ "$1" == "s3api" ]]; then
  echo "None"
  exit 0
fi
if [[ "$1" == "s3" && "$2" == "sync" ]]; then
  exit 0
fi
echo "unexpected aws call: $*" >&2
exit 1
`,
  );
  writeExecutable(
    join(binDir, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "simulated CloudFront propagation miss" >&2
exit 22
`,
  );

  const result = runPublish([siteDir, "--slug", "demo-page"], {
    AWS_REGION: "us-east-1",
    PATH: `${binDir}:${process.env.PATH}`,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.output, /simulated CloudFront propagation miss/);
  assert.equal(existsSync(join(siteDir, ".paperclip-page", "state.json")), true);

  const state = JSON.parse(readFileSync(join(siteDir, ".paperclip-page", "state.json"), "utf8"));
  assert.equal(state.bucket, "paperclip-pages-test");
  assert.equal(state.prefix, "demo-page/");
  assert.equal(state.url, "https://pages.example.test/demo-page/");
});
