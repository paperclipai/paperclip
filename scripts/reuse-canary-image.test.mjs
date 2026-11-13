import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { reuseCanaryImage } from "./reuse-canary-image.mjs";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

test("reuses only an exact-source, master-signed multi-platform image by digest", async () => {
  const calls = [];
  const reused = await reuseCanaryImage(sha, {
    resolve: async source => { assert.equal(source, sha); return digest; },
    run: async (...args) => calls.push(args),
  });
  assert.equal(reused, true);
  assert.deepEqual(calls, [
    ["gh", ["attestation", "verify", `oci://ghcr.io/paperclipai/paperclip@${digest}`,
      "--repo", "paperclipai/paperclip", "--bundle-from-oci",
      "--signer-workflow", "paperclipai/paperclip/.github/workflows/docker.yml",
      "--source-ref", "refs/heads/master", "--source-digest", sha,
      "--signer-digest", sha, "--deny-self-hosted-runners"]],
    ["docker", ["buildx", "imagetools", "create", "-t",
      "ghcr.io/paperclipai/paperclip:sha-aaaaaaa", `ghcr.io/paperclipai/paperclip@${digest}`]],
  ]);
});

test("a missing master image enables the fallback without retagging", async () => {
  assert.equal(await reuseCanaryImage(sha, {
    resolve: async () => null,
    run: () => assert.fail("A missing image must not be promoted"),
  }), false);
});

test("registry and provenance failures stop promotion rather than bypass verification", async () => {
  await assert.rejects(reuseCanaryImage(sha, {
    resolve: async () => { throw new Error("HTTP 403"); },
    run: () => assert.fail("A registry failure must not be promoted"),
  }), /HTTP 403/);
  let commands = 0;
  await assert.rejects(reuseCanaryImage(sha, {
    resolve: async () => digest,
    run: command => {
      assert.equal(command, "gh");
      commands++;
      throw new Error("Untrusted source or signature");
    },
  }), /Untrusted source/);
  assert.equal(commands, 1);
});

test("invalid source refs and digests cannot reach external commands", async () => {
  for (const invalid of ["master", "a".repeat(7), "a".repeat(40) + "\n"]) {
    await assert.rejects(reuseCanaryImage(invalid, {
      resolve: () => assert.fail("Invalid source accepted"),
    }));
  }
  await assert.rejects(reuseCanaryImage(sha, {
    resolve: async () => "mutable:tag",
    run: () => assert.fail("Invalid digest accepted"),
  }));
});

test("canary reuse gates both native builds and still runs convergent promotion", () => {
  const workflow = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");
  const reuse = workflow.split("  reuse_canary_image:\n")[1].split("  build-and-push:\n")[0];
  assert.match(reuse, /github.repository_id == '1170821064'.*startsWith\(github.ref, 'refs\/tags\/canary\/v'\)/);
  assert.match(reuse, /node scripts\/reuse-canary-image.mjs/);
  const build = workflow.split("  build-and-push:\n")[1].split("  merge-and-push:\n")[0];
  assert.match(build, /needs: \[reuse_canary_image\]/);
  assert.match(build, /!cancelled\(\).*result == 'skipped'.*result == 'success'.*outputs.reused == 'false'/);
  assert.match(build, /platform: linux\/amd64/);
  assert.match(build, /platform: linux\/arm64/);
  const promotion = workflow.split("  promote_canary_channel:\n")[1];
  assert.match(promotion, /!cancelled\(\).*needs.merge-and-push.result == 'success'.*outputs.reused == 'true'/);
});
