import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../storybook-visual-baseline.mjs", import.meta.url).pathname;

test("downloads and verifies a checksum-pinned local baseline archive", () => {
  const root = mkdtempSync(join(tmpdir(), "storybook-visual-baseline-test-"));
  try {
    const source = join(root, "source");
    const cache = join(root, "cache");
    const snapshots = join(root, "snapshots");
    const manifest = join(root, "manifest.json");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "one.png"), "png-one");
    writeFileSync(join(source, "two.png"), "png-two");
    const archive = join(root, "snapshots.tgz");
    run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", source, "."]);
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const byteSize = statSync(archive).size;
    writeFileSync(
      manifest,
      JSON.stringify(
        {
          version: 1,
          baselineId: "test-baseline",
          snapshotCount: 2,
          archive: {
            url: `file://${archive}`,
            sha256,
            byteSize,
          },
          environment: {
            browser: "chromium",
            viewport: "1200x800",
            deviceScaleFactor: 1,
            platform: "test",
          },
        },
        null,
        2,
      ),
    );

    const env = {
      ...process.env,
      STORYBOOK_VISUAL_BASELINE_MANIFEST: manifest,
      STORYBOOK_VISUAL_BASELINE_CACHE_DIR: cache,
      STORYBOOK_VISUAL_SNAPSHOT_DIR: snapshots,
    };
    const download = spawnSync(process.execPath, [script, "download"], { env, encoding: "utf8" });
    assert.equal(download.status, 0, download.stderr);
    const verify = spawnSync(process.execPath, [script, "verify"], { env, encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify fails closed on snapshot count mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "storybook-visual-baseline-test-"));
  try {
    const snapshots = join(root, "snapshots");
    const manifest = join(root, "manifest.json");
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(join(snapshots, "one.png"), "png-one");
    const archive = join(root, "snapshots.tgz");
    run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", snapshots, "."]);
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const manifestBody = {
      version: 1,
      baselineId: "test-baseline",
      snapshotCount: 1,
      archive: {
        url: `file://${archive}`,
        sha256,
        byteSize: statSync(archive).size,
      },
    };
    writeFileSync(manifest, JSON.stringify(manifestBody));
    const env = {
      ...process.env,
      STORYBOOK_VISUAL_BASELINE_MANIFEST: manifest,
      STORYBOOK_VISUAL_BASELINE_CACHE_DIR: root,
      STORYBOOK_VISUAL_SNAPSHOT_DIR: snapshots,
    };
    const download = spawnSync(process.execPath, [script, "download"], { env, encoding: "utf8" });
    assert.equal(download.status, 0, download.stderr);
    writeFileSync(manifest, JSON.stringify({ ...manifestBody, snapshotCount: 2 }));
    unlinkSync(join(snapshots, "one.png"));
    const result = spawnSync(process.execPath, [script, "verify"], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /snapshot count mismatch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
