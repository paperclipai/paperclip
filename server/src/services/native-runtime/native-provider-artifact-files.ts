import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StorageService } from "../../storage/types.js";
import {
  canonicalProviderPackJson,
  type ProviderPackIdentity,
} from "./remote-provider-pack-verification.js";

export const schema = "paperclip.native-provider-artifacts.v1";
export const names = [
  "nodeCommand",
  "opencodeProxy",
  "opencodeExecutable",
] as const;
export const MAX_NATIVE_PROVIDER_ARTIFACT_BYTES = 512 * 1024 * 1024;
export type Name = (typeof names)[number];
export type Entry = {
  name: Name;
  path: string;
  sha256: string;
  byteSize: number;
};
export type Descriptor = {
  schema: typeof schema;
  target: ProviderPackIdentity["payload"]["target"];
  entries: Entry[];
};
export type NativeProviderArtifactSource = {
  sourceRoot: string;
  manifest: ProviderPackIdentity;
  launchRoot: string;
  accountUid: number;
};
export type NativeProviderArtifactReceipt = {
  schema: typeof schema;
  artifactId: string;
  closureDigest: string;
  providerPackDigest: string;
  launchRoot: string;
  accountUid: number;
  manifest: ProviderPackIdentity;
};
export type BlobReference = {
  schema: typeof schema;
  companyId: string;
  artifactId: string;
  closureDigest: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  material: Record<string, unknown>;
};
export const digest = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const fail = (reason: string): never => {
  throw new Error(`native_provider_artifacts_${reason}`);
};
export const aad = (
  companyId: string,
  artifactId: string,
  closureDigest: string,
) =>
  Buffer.from(JSON.stringify([schema, companyId, artifactId, closureDigest]));
export const safeRelative = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !value.includes("\\") &&
  !/[\u0000-\u001f\u007f]/u.test(value) &&
  !posix.isAbsolute(value) &&
  value
    .split("/")
    .every((part) => part !== ".." && part !== "." && part !== "");
export const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

export function receiptFor(
  artifactId: string,
  closureDigest: string,
  source: NativeProviderArtifactSource,
): NativeProviderArtifactReceipt {
  return {
    schema,
    artifactId,
    closureDigest,
    launchRoot: source.launchRoot,
    accountUid: source.accountUid,
    providerPackDigest: source.manifest.digest,
    manifest: structuredClone(source.manifest),
  };
}

export function manifestIdentity(manifest: ProviderPackIdentity) {
  if (
    manifest?.schema !== "paperclip-runner/remote-provider-pack/v1" ||
    !manifest.payload ||
    manifest.digest !== digest(canonicalProviderPackJson(manifest.payload))
  )
    fail("manifest_invalid");
  if (
    manifest.payload.target.platform !== "linux" ||
    !["x64", "arm64"].includes(manifest.payload.target.architecture)
  )
    fail("target_invalid");
  for (const name of names) {
    const artifact = manifest.payload.artifacts[name];
    if (
      !artifact ||
      !safeRelative(artifact.path) ||
      !validDigest(artifact.sha256)
    )
      fail("manifest_invalid");
  }
}

export function launchRootIdentity(
  root: string,
  manifest: ProviderPackIdentity,
  accountUid: number,
) {
  if (!Number.isSafeInteger(accountUid) || accountUid < 0)
    fail("account_invalid");
  if (
    typeof root !== "string" ||
    root.length > 4096 ||
    !posix.isAbsolute(root) ||
    posix.normalize(root) !== root ||
    /[\\\u0000-\u001f\u007f]/u.test(root) ||
    !root.endsWith(
      `/.paperclip-runtime/paperclip-runner/provider-artifacts/${manifest.digest.slice(7)}`,
    )
  )
    fail("launch_root_invalid");
}

export function descriptorIdentity(
  descriptor: Descriptor,
  receipt: NativeProviderArtifactReceipt,
) {
  if (
    descriptor.schema !== schema ||
    !Array.isArray(descriptor.entries) ||
    descriptor.entries.length !== names.length ||
    canonicalProviderPackJson(
      descriptor.entries.map((entry) => entry.name).sort(),
    ) !== canonicalProviderPackJson([...names].sort()) ||
    canonicalProviderPackJson(descriptor.target) !==
      canonicalProviderPackJson(receipt.manifest.payload.target)
  )
    fail("descriptor_invalid");
  let bytes = 0;
  for (const entry of descriptor.entries) {
    if (
      entry.path !== receipt.manifest.payload.artifacts[entry.name]?.path ||
      entry.sha256 !== receipt.manifest.payload.artifacts[entry.name]?.sha256 ||
      !Number.isSafeInteger(entry.byteSize) ||
      entry.byteSize < 0
    )
      fail("descriptor_invalid");
    bytes += entry.byteSize;
  }
  if (bytes > MAX_NATIVE_PROVIDER_ARTIFACT_BYTES) fail("size_limit");
}

export async function fileDigest(path: string, signal?: AbortSignal) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("file_unsafe");
  const hash = createHash("sha256");
  let byteSize = 0;
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    for await (const bytes of handle.createReadStream({
      signal,
      autoClose: false,
    })) {
      byteSize += bytes.length;
      if (byteSize > MAX_NATIVE_PROVIDER_ARTIFACT_BYTES + 1024 * 1024)
        fail("size_limit");
      hash.update(bytes);
    }
  } finally {
    await handle.close();
  }
  return { sha256: `sha256:${hash.digest("hex")}`, byteSize };
}

export async function readDescriptor(path: string): Promise<Descriptor> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 512 * 1024) fail("descriptor_invalid");
    try {
      return JSON.parse(await handle.readFile("utf8")) as Descriptor;
    } catch {
      return fail("descriptor_invalid");
    }
  } finally {
    await handle.close();
  }
}

export function artifactReference(
  value: Record<string, unknown>,
  companyId: string,
  artifactId: string,
  closureDigest: string,
): BlobReference {
  const reference = value as BlobReference;
  if (
    reference.schema !== schema ||
    reference.companyId !== companyId ||
    reference.artifactId !== artifactId ||
    reference.closureDigest !== closureDigest ||
    !validDigest(reference.sha256) ||
    !Number.isSafeInteger(reference.byteSize) ||
    reference.byteSize <= 0 ||
    reference.byteSize > MAX_NATIVE_PROVIDER_ARTIFACT_BYTES + 1024 * 1024 ||
    typeof reference.objectKey !== "string" ||
    !reference.objectKey.startsWith(
      `${companyId}/native-provider-artifacts/${artifactId}/`,
    ) ||
    !/^[a-f0-9-]{36}\.pcpa$/.test(reference.objectKey.split("/").at(-1)!) ||
    reference.objectKey.split("/").length !== 4
  )
    fail("reference_invalid");
  return reference;
}

export async function verifyMaterialized(
  root: string,
  descriptor: Descriptor,
  signal?: AbortSignal,
): Promise<boolean> {
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    canonicalProviderPackJson((await readdir(root)).sort()) !==
      canonicalProviderPackJson(["manifest.json", ...names].sort())
  )
    fail("cache_changed");
  if (
    canonicalProviderPackJson(
      await readDescriptor(join(root, "manifest.json")),
    ) !== canonicalProviderPackJson(descriptor)
  )
    fail("cache_changed");
  for (const entry of descriptor.entries) {
    const actual = await fileDigest(join(root, entry.name), signal);
    if (actual.sha256 !== entry.sha256 || actual.byteSize !== entry.byteSize)
      fail("cache_changed");
  }
  return true;
}

export async function capture(
  source: NativeProviderArtifactSource,
  destination: string,
  signal?: AbortSignal,
): Promise<Descriptor> {
  manifestIdentity(source.manifest);
  const root = await lstat(source.sourceRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) fail("source_unsafe");
  const entries: Entry[] = [];
  let total = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    const artifact = source.manifest.payload.artifacts[name];
    let path = source.sourceRoot;
    for (const part of artifact.path.split("/")) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) fail("source_unsafe");
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      total += before.size;
      if (!before.isFile() || total > MAX_NATIVE_PROVIDER_ARTIFACT_BYTES)
        fail("size_limit");
      const hash = createHash("sha256");
      let copied = 0;
      const observe = new Transform({
        transform(bytes, _encoding, callback) {
          copied += bytes.length;
          hash.update(bytes);
          callback(
            copied > before.size
              ? new Error("native_provider_artifacts_source_changed")
              : null,
            bytes,
          );
        },
      });
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        observe,
        createWriteStream(join(destination, name), {
          flags: "wx",
          mode: 0o500,
        }),
        { signal },
      );
      const after = await handle.stat();
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        copied !== before.size ||
        `sha256:${hash.digest("hex")}` !== artifact.sha256
      )
        fail("source_changed");
      entries.push({
        name,
        path: artifact.path,
        sha256: artifact.sha256,
        byteSize: copied,
      });
    } finally {
      await handle.close();
    }
  }
  return { schema, target: source.manifest.payload.target, entries };
}

export async function receive(
  storage: StorageService,
  reference: BlobReference,
  target: string,
  signal?: AbortSignal,
) {
  const object = await storage.getObject(
    reference.companyId,
    reference.objectKey,
    { signal },
  );
  const hash = createHash("sha256");
  let bytes = 0;
  const observe = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(
        bytes > reference.byteSize
          ? new Error("native_provider_artifacts_size_mismatch")
          : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(
      object.stream,
      observe,
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (
      bytes !== reference.byteSize ||
      `sha256:${hash.digest("hex")}` !== reference.sha256
    )
      fail("object_changed");
  } finally {
    object.stream.destroy();
  }
}
