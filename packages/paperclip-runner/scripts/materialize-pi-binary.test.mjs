import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializePiBinary, PI_BINARY } from "./materialize-pi-binary.mjs";

test("rejects unsupported platforms before fetching", async () => {
  await assert.rejects(materializePiBinary("/unused", { platform: "darwin", arch: "arm64", fetch: () => { throw Error("unexpected download"); } }), /requires Linux x64/);
});

test("rejects a tampered archive before extracting anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-materialization-"));
  try {
    await assert.rejects(materializePiBinary(root, { platform: "linux", arch: "x64", fetch: async (url) => {
      assert.equal(url, PI_BINARY.url);
      return new Response("untrusted archive");
    } }), /archive integrity mismatch/);
    await assert.rejects(access(join(root, "vendor")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounds the downloaded archive before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-materialization-"));
  try {
    const chunk = new Uint8Array(1024 * 1024);
    await assert.rejects(materializePiBinary(root, { platform: "linux", arch: "x64", fetch: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(chunk); },
    })) }), /size bound/);
    await assert.rejects(access(join(root, "vendor")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
