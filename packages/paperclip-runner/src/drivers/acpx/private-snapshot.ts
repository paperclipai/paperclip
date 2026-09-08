import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const ACPX_PRIVATE_SNAPSHOT_ENV = "PAPERCLIP_ACPX_PRIVATE_SNAPSHOT";
export interface AcpxPrivateSnapshot {
  roots: string[];
  executable: string | null;
  digests: Record<string, string>;
  handoff: { path: string; digest: string };
  close(): Promise<void>;
}
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const within = (root: string, file: string) => {
  const rel = relative(root, file);
  return (
    rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
  );
};

/** macOS has no /proc directory descriptors. Freeze only the admitted package roots. */
export async function createAcpxPrivateSnapshot(
  sourceRoots: readonly string[],
  executable: FileHandle | null,
): Promise<AcpxPrivateSnapshot> {
  sourceRoots = await Promise.all(sourceRoots.map((root) => realpath(root)));
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "paperclip-acpx-")),
  );
  const roots = sourceRoots.map((_, index) => join(directory, String(index)));
  const digests: Record<string, string> = {};
  const directories: string[] = [directory];
  let bytesCopied = 0;
  let filesCopied = 0;
  const sourceIdentities = await Promise.all(
    sourceRoots.map((root) => lstat(root, { bigint: true })),
  );
  const same = (
    a: (typeof sourceIdentities)[number],
    b: (typeof sourceIdentities)[number],
  ) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs;
  const close = async () => {
    for (const dir of directories)
      await chmod(dir, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  };
  const mapPath = (source: string): string | null => {
    const candidates = sourceRoots
      .map((root, index) => ({ root, index }))
      .filter(({ root }) => within(root, source))
      .sort((a, b) => b.root.length - a.root.length);
    const match = candidates[0];
    return match
      ? resolve(roots[match.index]!, relative(match.root, source))
      : null;
  };
  const copy = async (
    source: string,
    target: string,
    root: string,
  ): Promise<void> => {
    if (++filesCopied > 30_000)
      throw new Error("ACPX package snapshot exceeds its file bound");
    const before = await lstat(source, { bigint: true });
    if (before.isSymbolicLink()) {
      const canonical = await realpath(source);
      const mapped = mapPath(canonical);
      // Package-manager links to unqualified packages do not grant import authority.
      if (mapped) await symlink(mapped, target);
      return;
    }
    if (!within(root, await realpath(source)))
      throw new Error("ACPX snapshot escaped its package");
    if (before.isDirectory()) {
      await mkdir(target, { mode: 0o700 });
      directories.push(target);
      for (const entry of await readdir(source))
        await copy(join(source, entry), join(target, entry), root);
      if (!same(before, await lstat(source, { bigint: true })))
        throw new Error("ACPX package directory changed during snapshot");
      return;
    }
    if (!before.isFile() || before.size > 16n * 1024n * 1024n)
      throw new Error("ACPX module must be a bounded regular file");
    bytesCopied += Number(before.size);
    if (bytesCopied > 128 * 1024 * 1024)
      throw new Error("ACPX package snapshot exceeds its byte bound");
    const handle = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!same(before, await handle.stat({ bigint: true })))
        throw new Error("ACPX module changed before snapshot");
      const bytes = await handle.readFile();
      if (
        !same(before, await handle.stat({ bigint: true })) ||
        !same(before, await lstat(source, { bigint: true }))
      ) {
        throw new Error("ACPX module changed during snapshot");
      }
      await writeFile(target, bytes, { flag: "wx", mode: 0o400 });
      digests[target] = digest(bytes);
    } finally {
      await handle.close();
    }
  };
  try {
    for (let index = 0; index < sourceRoots.length; index++) {
      await copy(sourceRoots[index]!, roots[index]!, sourceRoots[index]!);
      if (
        !same(
          sourceIdentities[index]!,
          await lstat(sourceRoots[index]!, { bigint: true }),
        )
      ) {
        throw new Error("ACPX package root changed during snapshot");
      }
    }
    // Supply bare-package lookup links only for already admitted package roots.
    const packages: Array<{ name: string; root: string }> = [];
    for (const root of roots) {
      const file = await open(join(root, "package.json")).catch(() => null);
      if (!file) continue;
      try {
        const metadata = JSON.parse(await file.readFile("utf8"));
        if (
          typeof metadata.name === "string" &&
          /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(metadata.name)
        ) {
          packages.push({ name: metadata.name, root });
        }
      } finally {
        await file.close();
      }
    }
    for (const root of roots)
      for (const pkg of packages) {
        const target = join(root, "node_modules", pkg.name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        // Include generated directories in cleanup and read-only sealing.
        directories.push(join(root, "node_modules"), dirname(target));
        await symlink(pkg.root, target).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
      }
    let executablePath: string | null = null;
    if (executable) {
      const before = await executable.stat({ bigint: true });
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await executable.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!read.bytesRead)
          throw new Error("ACPX executable ended during snapshot");
        offset += read.bytesRead;
      }
      if (!same(before, await executable.stat({ bigint: true })))
        throw new Error("ACPX executable changed during snapshot");
      executablePath = join(directory, "runtime");
      await writeFile(executablePath, bytes, { flag: "wx", mode: 0o500 });
      digests[executablePath] = digest(bytes);
    }
    const manifest = Buffer.from(
      JSON.stringify({ roots, executable: executablePath, digests }),
    );
    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, manifest, { flag: "wx", mode: 0o400 });
    for (const dir of new Set(directories)) await chmod(dir, 0o500);
    return {
      roots,
      executable: executablePath,
      digests,
      handoff: { path: manifestPath, digest: digest(manifest) },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
