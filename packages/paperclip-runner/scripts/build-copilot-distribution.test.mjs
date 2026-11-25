import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildPinnedCopilotDistribution, readCopilotArchiveEntries, verifyCopilotArchiveIntegrity } from "./build-copilot-distribution.mjs";

function header(name, body, type = "0") {
  const block = Buffer.alloc(512); block.write(name, 0, 100, "ascii");
  block.write("0000755\0", 100); block.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  block.fill(32, 148, 156); block.write(type, 156); block.write("ustar\0", 257); block.write("00", 263);
  block.write(block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([block, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
function archive(replace = {}) {
  const entries = ["package/copilot", "package/package.json", "package/LICENSE.md", "package/README.md"];
  return Buffer.concat([...entries.map(name => header(name === "package/copilot" ? replace.name ?? name : name,
    Buffer.from(name === "package/copilot" ? "binary" : "data"), name === "package/copilot" ? replace.type ?? "0" : "0")), Buffer.alloc(1024)]);
}

test("strict archive reader admits only complete pinned npm entry shape", () => {
  const entries = readCopilotArchiveEntries(archive());
  assert.equal(entries.get("package/copilot").toString(), "binary");
  for (const invalid of [archive({ name: "../../copilot" }), archive({ type: "2" }), archive({ type: "x" }),
    archive({ name: "package/package.json" }), archive().subarray(0, -512), Buffer.concat([archive(), Buffer.from("hidden")])]) {
    assert.throws(() => readCopilotArchiveEntries(invalid));
  }
  const changed = archive(); changed[20] ^= 1;
  assert.throws(() => readCopilotArchiveEntries(changed), /checksum/);
  const padding = archive(); padding[512 + 6] = 1;
  assert.throws(() => readCopilotArchiveEntries(padding), /padding/);
});

test("SHA-512 archive verification rejects corruption and malformed pins", () => {
  const bytes = Buffer.from("pinned archive"); const pin = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  verifyCopilotArchiveIntegrity(bytes, pin);
  assert.throws(() => verifyCopilotArchiveIntegrity(Buffer.from("tampered"), pin), /mismatch/);
  assert.throws(() => verifyCopilotArchiveIntegrity(bytes, "sha512-invalid"), /malformed/);
});

test("builder uses only exact pinned registry URL and refuses a corrupt download before writes", async () => {
  let called = false;
  await assert.rejects(buildPinnedCopilotDistribution({ outputRoot: "/unused-copilot-build", platform: "linux", architecture: "x64" }, {
    fetchImpl: async (url, options) => {
      called = true;
      assert.equal(url, "https://registry.npmjs.org/@github/copilot-linux-x64/-/copilot-linux-x64-1.0.88.tgz");
      assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
      return new Response("corrupt");
    },
  }), /integrity mismatch/);
  assert.equal(called, true);
  await assert.rejects(buildPinnedCopilotDistribution({ outputRoot: "relative", platform: "linux", architecture: "x64" }), /normalized absolute/);
});

test("builder bounds download metadata before streaming", async () => {
  await assert.rejects(buildPinnedCopilotDistribution({ outputRoot: "/unused-copilot-build", platform: "linux", architecture: "x64" }, {
    fetchImpl: async () => new Response("small", { headers: { "content-length": String(129 * 1024 * 1024) } }),
  }), /download bound/);
});
