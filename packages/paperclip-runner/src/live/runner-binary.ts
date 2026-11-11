import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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

const RUNNER_BINARY_HEADER_BYTES = 64 * 1024;

/**
 * `runnerBinaryTarget(readFileSync(path))`, reading only the 64 KiB header
 * unless the header cannot answer. A daemon is tens of megabytes; reading all
 * of it to classify the target blocked the server's event loop on a slow disk.
 */
export function runnerBinaryFileTarget(path: string): string | null {
  // The packaged daemon is release-owned and does not change while the process
  // runs. After the first read, each run costs one stat: the target is reused
  // while the device, inode, size, modification and change times match.
  const metadata = statSync(path, { bigint: true });
  const key = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
  const cached = targetCache.get(path);
  if (cached?.key === key) return cached.target;
  const target = readRunnerBinaryFileTarget(path);
  targetCache.set(path, { key, target });
  return target;
}

const targetCache = new Map<string, { key: string; target: string | null }>();

function readRunnerBinaryFileTarget(path: string): string | null {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(RUNNER_BINARY_HEADER_BYTES);
    let length = 0;
    let ended = false;
    while (length < header.length) {
      const bytesRead = readSync(descriptor, header, length, header.length - length, null);
      if (bytesRead === 0) { ended = true; break; }
      length += bytesRead;
    }
    const target = runnerBinaryTarget(header.subarray(0, length));
    return target !== null || ended ? target : runnerBinaryTarget(readFileSync(path));
  } finally {
    closeSync(descriptor);
  }
}

export function resolvePackagedRunnerBinary(outputRoot: string, platform = process.platform, architecture = process.arch): string | null {
  const target = `${platform}-${architecture}`, executable = platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  for (const binary of [resolve(outputRoot, "bin", target, executable), resolve(outputRoot, "bin", executable)]) {
    if (!existsSync(binary)) continue;
    if (runnerBinaryFileTarget(binary) !== target) {
      throw new Error(`runner_runtime_incompatible: packaged daemon does not match ${target}; install the matching Paperclip release`);
    }
    return binary;
  }
  return null;
}
