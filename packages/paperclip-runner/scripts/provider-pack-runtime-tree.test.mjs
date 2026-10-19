import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeControllerArtifactsFromProviderPack } from "./provider-pack-runtime-tree.mjs";

test("image and native producer packs retain identical provider outputs despite different controller artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-producers-"));
  try {
    const packs = [join(root, "image"), join(root, "native")];
    for (const pack of packs) {
      mkdirSync(join(pack, "dist", "cli"), { recursive: true });
      writeFileSync(join(pack, "dist", "cli", "acpx-runtime-sidecar.cjs"), "identical provider bridge\n");
    }
    mkdirSync(join(packs[1], "dist", "bin"));
    writeFileSync(join(packs[1], "dist", "bin", "paperclip-runnerd"), "host-specific daemon");
    mkdirSync(join(packs[1], "dist", "remote-provider-packs"));
    writeFileSync(join(packs[1], "dist", "remote-provider-packs", "prior-pack.json"), "earlier release identity");
    for (const pack of packs) {
      removeControllerArtifactsFromProviderPack(pack);
      assert.deepEqual(readdirSync(join(pack, "dist")), ["cli"]);
      assert.equal(readFileSync(join(pack, "dist", "cli", "acpx-runtime-sidecar.cjs"), "utf8"), "identical provider bridge\n");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removing an owned controller-artifact link preserves its external target", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-controller-link-"));
  try {
    const pack = join(root, "pack"), outside = join(root, "outside");
    mkdirSync(join(pack, "dist"), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(outside, "preserved"), "original");
    symlinkSync(outside, join(pack, "dist", "bin"));
    removeControllerArtifactsFromProviderPack(pack);
    assert.equal(existsSync(join(pack, "dist", "bin")), false);
    assert.equal(readFileSync(join(outside, "preserved"), "utf8"), "original");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
