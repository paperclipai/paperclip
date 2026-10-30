import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export type AcpxPackageJsonResolver = (
  packageName: string,
  issuerPackageJsonPath?: string,
) => string;
export type AcpxCommandFormat = "commonjs" | "module";
export interface AcpxPackageMetadata {
  name?: string;
  version?: string;
  bin?: unknown;
  type?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  peerDependenciesMeta?: unknown;
}

export function packageModuleFormat(value: unknown): AcpxCommandFormat {
  return value === "module" ? "module" : "commonjs";
}

export async function readPackageMetadata(path: string, packageName: string): Promise<AcpxPackageMetadata> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > 256n * 1024n) throw new Error(`ACPX package ${packageName} has invalid package metadata`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) throw new Error(`ACPX package ${packageName} changed during metadata admission`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error(`ACPX package ${packageName} ended during metadata admission`);
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const lexical = await lstat(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || lexical.dev !== before.dev || lexical.ino !== before.ino || lexical.size !== before.size || lexical.mtimeNs !== before.mtimeNs || lexical.ctimeNs !== before.ctimeNs) {
      throw new Error(`ACPX package ${packageName} changed during metadata admission`);
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`ACPX package ${packageName} has invalid package metadata`);
    return value as AcpxPackageMetadata;
  } finally { await handle.close(); }
}
