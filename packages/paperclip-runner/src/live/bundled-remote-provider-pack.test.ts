import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { bundledRemoteProviderPackManifestPath, bundledRemoteRunnerBinary } from "./bundled-remote-provider-pack.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function release() {
  const root = mkdtempSync(join(tmpdir(), "paperclip-remote-release-")); roots.push(root);
  const output = join(root, "dist/vendor/paperclip-runner"), binary = join(output, "bin/linux-x64/paperclip-runnerd");
  mkdirSync(join(output, "bin/linux-x64"), { recursive: true });
  const bytes = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(62, 18);
  writeFileSync(binary, bytes);
  const manifest = { schema: "paperclip.runner.release-binaries.v1", sourceRevision: "a".repeat(40), platforms: { "linux-x64": { path: "linux-x64/paperclip-runnerd", sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex") } } };
  const save = () => writeFileSync(join(output, "bin/release-manifest.json"), JSON.stringify(manifest)); save();
  return { output, binary, bytes, manifest, save, url: pathToFileURL(join(output, "live/bundled-remote-provider-pack.js")).href };
}
it("selects the packaged Linux daemon even when the controller is macOS", () => {
  const r = release();
  expect(bundledRemoteRunnerBinary(r.url)).toBe(r.binary);
  expect(bundledRemoteProviderPackManifestPath(r.url)).toBe(join(r.output, "remote-provider-packs/linux-x64/provider-pack.json"));
});
it.each(["bytes", "architecture", "digest", "path"])("rejects a mismatched packaged remote daemon: %s", reason => {
  const r = release();
  if (reason === "bytes") writeFileSync(r.binary, Buffer.alloc(64));
  if (reason === "architecture") { r.bytes.writeUInt16LE(183, 18); writeFileSync(r.binary, r.bytes); }
  if (reason === "digest") r.manifest.platforms["linux-x64"].sha256 = "sha256:" + "b".repeat(64);
  if (reason === "path") r.manifest.platforms["linux-x64"].path = "../../foreign-daemon";
  r.save(); expect(() => bundledRemoteRunnerBinary(r.url)).toThrow(/runner_remote_artifact_(incompatible|unavailable)/);
});
it("resolves source development through built package assets without a runtime override", () => {
  expect(bundledRemoteProviderPackManifestPath("file:///repo/packages/paperclip-runner/src/live/bundled-remote-provider-pack.ts"))
    .toBe("/repo/packages/paperclip-runner/dist/remote-provider-packs/linux-x64/provider-pack.json");
  for (const url of ["https://example.com/dist/live/bundled-remote-provider-pack.js", "file:///tmp/foreign.js", "file:///repo/dist/live/bundled-remote-provider-pack.js?override=1"]) {
    expect(() => bundledRemoteProviderPackManifestPath(url)).toThrow("package file layout");
  }
});
