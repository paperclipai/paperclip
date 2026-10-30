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

// Match the admission limit and reserve separate space for qualified modules.
export const MAX_ACPX_RUNTIME_EXECUTABLE_BYTES = 384 * 1024 * 1024;
const MAX_PACKAGE_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = MAX_PACKAGE_SNAPSHOT_BYTES + MAX_ACPX_RUNTIME_EXECUTABLE_BYTES;

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

async function readSnapshotBytes(handle: FileHandle, byteLength: number): Promise<Buffer> {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!read.bytesRead) throw new Error("ACPX file ended during snapshot");
    offset += read.bytesRead;
  }
  return bytes;
}

export interface AcpxPrivateSnapshotOptions {
  maxFiles?: number;
  maxModuleBytes?: number;
  maxPackageBytes?: number;
  streamingCopy?: boolean;
  skipPath?: (source: string, packageRoot: string) => boolean;
  packageLinks?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  signal?: AbortSignal;
}

async function copySnapshotStream(source: FileHandle, target: string, expectedBytes: number, signal?: AbortSignal): Promise<string> {
  const targetHandle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400);
  const hash = createHash("sha256");
  let copied = 0;
  const stream = source.createReadStream({ autoClose: false });
  const onAbort = () => stream.destroy();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      if (copied + chunk.length > expectedBytes) throw new Error("ACPX module exceeded its admitted size during snapshot");
      copied += chunk.length;
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        signal?.throwIfAborted();
        const { bytesWritten } = await targetHandle.write(chunk, offset);
        if (bytesWritten <= 0) throw new Error("ACPX snapshot write made no progress");
        offset += bytesWritten;
      }
    }
    signal?.throwIfAborted();
    if (copied !== expectedBytes) throw new Error("ACPX module ended during snapshot");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await targetHandle.close();
  }
  return hash.digest("hex");
}

/** macOS has no /proc directory descriptors. Freeze only the admitted package roots. */
export async function createAcpxPrivateSnapshot(
  sourceRoots: readonly string[],
  executable: FileHandle | null,
  options: AcpxPrivateSnapshotOptions = {},
): Promise<AcpxPrivateSnapshot> {
  sourceRoots = await Promise.all(sourceRoots.map((root) => realpath(root)));
  const executableIdentity = executable ? await executable.stat({ bigint: true }) : null;
  const sourceIdentities = await Promise.all(
    sourceRoots.map((root) => lstat(root, { bigint: true })),
  );
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "paperclip-acpx-")),
  );
  const roots = sourceRoots.map((_, index) => join(directory, String(index)));
  const digests: Record<string, string> = {};
  const directories: string[] = [directory];
  let bytesCopied = 0;
  let filesCopied = 0;
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
    options.signal?.throwIfAborted();
    if (options.skipPath?.(source, root)) return;
    options.signal?.throwIfAborted();
    if (++filesCopied > (options.maxFiles ?? 30_000))
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
    // The separately pinned native binary is copied below with its own bound.
    if (before.isFile() && executableIdentity && before.dev === executableIdentity.dev && before.ino === executableIdentity.ino) return;
    if (!before.isFile()) throw new Error("ACPX module must be a bounded regular file");
    if (before.size > BigInt(options.maxModuleBytes ?? 16 * 1024 * 1024))
      throw new Error("ACPX module must be a bounded regular file");
    bytesCopied += Number(before.size);
    if (bytesCopied > (options.maxPackageBytes ?? MAX_PACKAGE_SNAPSHOT_BYTES))
      throw new Error("ACPX package snapshot exceeds its byte bound");
    const handle = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!same(before, await handle.stat({ bigint: true })))
        throw new Error("ACPX module changed before snapshot");
      const assertUnchanged = async () => {
        options.signal?.throwIfAborted();
        if (!same(before, await handle.stat({ bigint: true })) || !same(before, await lstat(source, { bigint: true }))) {
          throw new Error("ACPX module changed during snapshot");
        }
      };
      if (options.streamingCopy) {
        await assertUnchanged();
        digests[target] = await copySnapshotStream(handle, target, Number(before.size), options.signal);
        await assertUnchanged();
      } else {
        const bytes = await readSnapshotBytes(handle, Number(before.size));
        await assertUnchanged();
        await writeFile(target, bytes, { flag: "wx", mode: 0o400 });
        digests[target] = digest(bytes);
      }
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
    const linkPackage = async (root: string, name: string, sourceRoot: string) => {
      options.signal?.throwIfAborted();
      const target = join(root, "node_modules", name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      directories.push(join(root, "node_modules"), dirname(target));
      await symlink(sourceRoot, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    };
    if (options.packageLinks) {
      for (let index = 0; index < roots.length; index++) {
        for (const [name, sourceRoot] of options.packageLinks.get(sourceRoots[index]!) ?? []) {
          const targetIndex = sourceRoots.indexOf(sourceRoot);
          if (targetIndex < 0) throw new Error(`ACPX package link ${name} has no admitted target`);
          await linkPackage(roots[index]!, name, roots[targetIndex]!);
        }
      }
    } else {
      for (const root of roots)
        for (const pkg of packages) await linkPackage(root, pkg.name, pkg.root);
    }
    let executablePath: string | null = null;
    if (executable) {
      const before = await executable.stat({ bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_ACPX_RUNTIME_EXECUTABLE_BYTES)) {
        throw new Error("ACPX runtime executable must be a bounded executable file");
      }
      // The bigint bound above makes this conversion exact before allocation.
      const executableBytes = Number(before.size);
      bytesCopied += executableBytes;
      if (bytesCopied > MAX_SNAPSHOT_BYTES) {
        throw new Error("ACPX snapshot exceeds its byte bound");
      }
      const bytes = await readSnapshotBytes(executable, executableBytes);
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
