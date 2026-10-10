import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePackagedRunnerBinary, runnerBinaryTarget } from "./runner-binary.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function header(target: string) {
  const bytes = Buffer.alloc(64);
  if (target.startsWith("darwin")) { bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(target.endsWith("arm64") ? 0x0100000c : 0x01000007, 4); }
  else { bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(target.endsWith("arm64") ? 183 : 62, 18); }
  return bytes;
}
function fixture() { const root = mkdtempSync(join(tmpdir(), "runner-platform-")); roots.push(root); return root; }
function binary(root: string, target: string | null, bytes: Buffer) {
  const folder = join(root, "dist", "bin", ...(target ? [target] : [])); mkdirSync(folder, { recursive: true });
  const file = join(folder, "paperclip-runnerd"); writeFileSync(file, bytes); return file;
}
describe("packaged native daemon target", () => {
  it.each(["darwin-arm64", "darwin-x64", "linux-x64"])("selects %s from a universal package rather than the build-host legacy binary", target => {
    const root = fixture(); binary(root, null, header("darwin-arm64"));
    for (const t of ["darwin-arm64", "darwin-x64", "linux-x64"]) binary(root, t, header(t));
    const [platform, architecture] = target.split("-");
    expect(runnerBinaryTarget(header(target))).toBe(target);
    expect(resolvePackagedRunnerBinary(join(root, "dist"), platform as NodeJS.Platform, architecture as typeof process.arch)).toBe(join(root, "dist", "bin", target, "paperclip-runnerd"));
  });
  it("fails an installed Linux product with a Darwin daemon instead of silently selecting it", () => {
    const root = fixture(); binary(root, null, header("darwin-arm64"));
    expect(() => resolvePackagedRunnerBinary(join(root, "dist"), "linux", "x64")).toThrow("runner_runtime_incompatible");
  });
  it("rejects a mislabeled target even when a compatible legacy executable exists", () => {
    const root = fixture(); binary(root, null, header("linux-x64")); binary(root, "linux-x64", header("darwin-arm64"));
    expect(() => resolvePackagedRunnerBinary(join(root, "dist"), "linux", "x64")).toThrow("runner_runtime_incompatible");
  });
  it("retains a matching local legacy build and permits the source-only debug fallback", () => {
    const root = fixture(); expect(resolvePackagedRunnerBinary(join(root, "dist"), "linux", "x64")).toBeNull();
    const legacy = binary(root, null, header("linux-x64")); expect(resolvePackagedRunnerBinary(join(root, "dist"), "linux", "x64")).toBe(legacy);
  });
  it("rejects malformed, truncated and unknown binary formats", () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(64), header("linux-x64").subarray(0, 19)]) expect(runnerBinaryTarget(bytes)).toBeNull();
  });
});
