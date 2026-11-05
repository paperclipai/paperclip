import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Native binary headers bind the packaged executable to its actual target. */
export function runnerBinaryTarget(bytes: Buffer): string | null {
  if (bytes.length < 20) return null;
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1) {
    const machine = bytes.readUInt16LE(18);
    return machine === 62 ? "linux-x64" : machine === 183 ? "linux-arm64" : null;
  }
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    return cpu === 0x01000007 ? "darwin-x64" : cpu === 0x0100000c ? "darwin-arm64" : null;
  }
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const offset = bytes.readUInt32LE(60);
    if (offset <= bytes.length - 6 && bytes.readUInt32LE(offset) === 0x00004550) {
      const machine = bytes.readUInt16LE(offset + 4);
      return machine === 0x8664 ? "win32-x64" : machine === 0xaa64 ? "win32-arm64" : null;
    }
  }
  return null;
}

export function resolvePackagedRunnerBinary(outputRoot: string, platform = process.platform, architecture = process.arch): string | null {
  const target = `${platform}-${architecture}`, executable = platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  for (const binary of [resolve(outputRoot, "bin", target, executable), resolve(outputRoot, "bin", executable)]) {
    if (!existsSync(binary)) continue;
    if (runnerBinaryTarget(readFileSync(binary)) !== target) {
      throw new Error(`runner_runtime_incompatible: packaged daemon does not match ${target}; install the matching Paperclip release`);
    }
    return binary;
  }
  return null;
}
