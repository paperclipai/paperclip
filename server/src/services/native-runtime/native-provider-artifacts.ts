import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray, not, sql } from "drizzle-orm";
import {
  environmentLeases,
  heartbeatRuns,
  nativeRunFinalizations,
  nativeProviderArtifacts,
  nativeProviderArtifactReferences,
  type Db,
} from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import {
  captureNativeHarnessArchive,
  restoreNativeHarnessArchive,
} from "./native-harness-backup-archive.js";
import {
  lockNativeRunnerCheckpointOwner,
  validateNativeRunnerCheckpointOwner,
  type NativeRunnerCheckpointFenceOwner,
} from "./native-runner-checkpoint.js";
import {
  canonicalProviderPackJson,
  type ProviderPackIdentity,
} from "./remote-provider-pack-verification.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";

const schema = "paperclip.native-provider-artifacts.v1";
const names = ["nodeCommand", "opencodeProxy", "opencodeExecutable"] as const;
export const MAX_NATIVE_PROVIDER_ARTIFACT_BYTES = 512 * 1024 * 1024;
type Name = (typeof names)[number];
type Entry = { name: Name; path: string; sha256: string; byteSize: number };
type Descriptor = {
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
type BlobReference = {
  schema: typeof schema;
  companyId: string;
  artifactId: string;
  closureDigest: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  material: Record<string, unknown>;
};
const digest = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fail = (reason: string): never => {
  throw new Error(`native_provider_artifacts_${reason}`);
};
const aad = (companyId: string, artifactId: string, closureDigest: string) =>
  Buffer.from(JSON.stringify([schema, companyId, artifactId, closureDigest]));
const safeRelative = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !value.includes("\\") &&
  !/[\u0000-\u001f\u007f]/u.test(value) &&
  !posix.isAbsolute(value) &&
  value
    .split("/")
    .every((part) => part !== ".." && part !== "." && part !== "");
const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

function receiptFor(
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

async function recordRunReceipt(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  owner: NativeRunnerCheckpointFenceOwner,
  receipt: NativeProviderArtifactReceipt,
) {
  await tx
    .update(heartbeatRuns)
    .set({
      runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({ nativeProviderArtifacts: receipt })}::jsonb`,
    })
    .where(
      and(
        eq(heartbeatRuns.companyId, owner.companyId),
        eq(heartbeatRuns.id, owner.authorityRunId),
      ),
    );
}

function manifestIdentity(manifest: ProviderPackIdentity) {
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

function launchRootIdentity(
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

function descriptorIdentity(
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

async function artifactOwnerFence(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  owner: NativeRunnerCheckpointFenceOwner,
  manifest: ProviderPackIdentity,
) {
  await validateNativeRunnerCheckpointOwner(
    tx,
    owner,
    await lockNativeRunnerCheckpointOwner(tx, owner),
    false,
  );
  const [run] = await tx
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.nativeIssueId,
      sessionId: heartbeatRuns.nativeSessionId,
      driver: heartbeatRuns.driverKind,
      profile: heartbeatRuns.runnerProfileJson,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, owner.companyId),
        eq(heartbeatRuns.id, owner.authorityRunId),
      ),
    )
    .for("share");
  const receipt = run?.profile?.nativeProviderPackAdmission as
    Record<string, unknown> | undefined;
  const state = run?.profile?.nativeProviderPackAdmissionState as
    Record<string, unknown> | undefined;
  if (
    !run ||
    run.issueId !== owner.issueId ||
    run.driver !== "opencode_server" ||
    !run.sessionId ||
    state?.schema !== "paperclip.native-provider-pack-admission-state.v1" ||
    state.state !== "verified" ||
    receipt?.schema !== "paperclip.native-provider-pack-admission.v1" ||
    receipt.stage !== "session_admitted" ||
    receipt.authority !== "core_verified_selection" ||
    receipt.companyId !== owner.companyId ||
    receipt.runId !== run.id ||
    receipt.agentId !== run.agentId ||
    receipt.sessionId !== run.sessionId ||
    receipt.providerPackDigest !== manifest.digest ||
    receipt.sourceRevision !== manifest.payload.runnerSourceRevision ||
    receipt.opencodeProxySha256 !==
      manifest.payload.artifacts.opencodeProxy.sha256
  )
    fail("admission_unverified");
}

async function fileDigest(path: string, signal?: AbortSignal) {
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

async function readDescriptor(path: string): Promise<Descriptor> {
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

function artifactReference(
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

async function verifyMaterialized(
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

async function capture(
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

async function receive(
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

export async function retainNativeProviderArtifacts(input: {
  db: Db;
  storage: StorageService;
  owner: NativeRunnerCheckpointFenceOwner;
  source: NativeProviderArtifactSource;
  signal?: AbortSignal;
}): Promise<NativeProviderArtifactReceipt> {
  const scratch = await mkdtemp(join(tmpdir(), "pc-provider-artifacts-"));
  const files = join(scratch, "files");
  await mkdir(files, { mode: 0o700 });
  const key = randomBytes(32);
  try {
    manifestIdentity(input.source.manifest);
    launchRootIdentity(
      input.source.launchRoot,
      input.source.manifest,
      input.source.accountUid,
    );
    await input.db.transaction((tx) =>
      artifactOwnerFence(tx, input.owner, input.source.manifest),
    );
    const descriptor = await capture(input.source, files, input.signal);
    const closureDigest = digest(canonicalProviderPackJson(descriptor));
    const uploadToken = randomUUID();
    const selected = await input.db.transaction(async (tx) => {
      await artifactOwnerFence(tx, input.owner, input.source.manifest);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${input.owner.companyId}:${closureDigest}`}, 0))`,
      );
      let [row] = await tx
        .select()
        .from(nativeProviderArtifacts)
        .where(
          and(
            eq(nativeProviderArtifacts.companyId, input.owner.companyId),
            eq(nativeProviderArtifacts.closureDigest, closureDigest),
            eq(nativeProviderArtifacts.status, "ready"),
          ),
        )
        .for("update");
      if (!row) {
        const pending = await tx
          .select({ id: nativeProviderArtifacts.id })
          .from(nativeProviderArtifacts)
          .innerJoin(
            nativeProviderArtifactReferences,
            eq(
              nativeProviderArtifactReferences.artifactId,
              nativeProviderArtifacts.id,
            ),
          )
          .where(
            and(
              eq(nativeProviderArtifacts.companyId, input.owner.companyId),
              eq(nativeProviderArtifacts.status, "pending"),
              eq(
                nativeProviderArtifactReferences.companyId,
                input.owner.companyId,
              ),
              eq(nativeProviderArtifactReferences.runId, input.owner.runId),
            ),
          )
          .limit(4);
        if (pending.length >= 3) fail("pending_limit");
        [row] = await tx
          .insert(nativeProviderArtifacts)
          .values({
            companyId: input.owner.companyId,
            closureDigest,
            descriptor,
            uploadToken,
          })
          .returning();
      }
      if (
        !row ||
        canonicalProviderPackJson(row.descriptor) !==
          canonicalProviderPackJson(descriptor)
      )
        fail("unavailable");
      await tx
        .insert(nativeProviderArtifactReferences)
        .values({
          companyId: input.owner.companyId,
          artifactId: row.id,
          runId: input.owner.runId,
        })
        .onConflictDoNothing();
      if (row.status === "ready")
        await recordRunReceipt(
          tx,
          input.owner,
          receiptFor(row.id, closureDigest, input.source),
        );
      return row;
    });
    if (selected.status !== "ready") {
      const archive = join(scratch, "archive"),
        encrypted = join(scratch, "encrypted");
      await writeFile(
        join(files, "manifest.json"),
        JSON.stringify(descriptor),
        { mode: 0o600 },
      );
      await captureNativeHarnessArchive(
        files,
        archive,
        input.signal,
        MAX_NATIVE_PROVIDER_ARTIFACT_BYTES + 1024 * 1024,
      );
      const plaintext = await fileDigest(archive, input.signal),
        iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(input.owner.companyId, selected.id, closureDigest));
      await pipeline(
        createReadStream(archive),
        cipher,
        createWriteStream(encrypted, { flags: "wx", mode: 0o600 }),
        { signal: input.signal },
      );
      const reference: BlobReference = {
        schema,
        companyId: input.owner.companyId,
        artifactId: selected.id,
        closureDigest,
        objectKey: `${input.owner.companyId}/native-provider-artifacts/${selected.id}/${uploadToken}.pcpa`,
        ...(await fileDigest(encrypted, input.signal)),
        material: createLocalEncryptedCipher("write").encrypt(
          JSON.stringify({
            schema,
            companyId: input.owner.companyId,
            artifactId: selected.id,
            closureDigest,
            key: key.toString("base64"),
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            plaintext,
          }),
        ),
      };
      await input.db.transaction(async (tx) => {
        await artifactOwnerFence(tx, input.owner, input.source.manifest);
        const [owned] = await tx
          .update(nativeProviderArtifacts)
          .set({ reference, updatedAt: new Date() })
          .where(
            and(
              eq(nativeProviderArtifacts.companyId, input.owner.companyId),
              eq(nativeProviderArtifacts.id, selected.id),
              eq(nativeProviderArtifacts.uploadToken, uploadToken),
              eq(nativeProviderArtifacts.status, "pending"),
            ),
          )
          .returning({ id: nativeProviderArtifacts.id });
        if (!owned) fail("owner_changed");
      });
      await input.storage.putFile({
        companyId: input.owner.companyId,
        namespace: "native-provider-artifacts",
        objectKey: reference.objectKey,
        originalFilename: null,
        contentType: "application/octet-stream",
        body: createReadStream(encrypted),
        byteSize: reference.byteSize,
        sha256: reference.sha256.slice(7),
        signal: input.signal,
      });
      await receive(
        input.storage,
        reference,
        join(scratch, "verified"),
        input.signal,
      );
      const published = await input.db.transaction(async (tx) => {
        await artifactOwnerFence(tx, input.owner, input.source.manifest);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.owner.companyId}:${closureDigest}`}, 0))`,
        );
        const [winner] = await tx
          .select({ id: nativeProviderArtifacts.id })
          .from(nativeProviderArtifacts)
          .where(
            and(
              eq(nativeProviderArtifacts.companyId, input.owner.companyId),
              eq(nativeProviderArtifacts.closureDigest, closureDigest),
              eq(nativeProviderArtifacts.status, "ready"),
            ),
          )
          .for("update");
        if (winner) {
          await tx
            .insert(nativeProviderArtifactReferences)
            .values({
              companyId: input.owner.companyId,
              artifactId: winner.id,
              runId: input.owner.runId,
            })
            .onConflictDoNothing();
          await recordRunReceipt(
            tx,
            input.owner,
            receiptFor(winner.id, closureDigest, input.source),
          );
          return winner.id;
        }
        const rows = await tx
          .update(nativeProviderArtifacts)
          .set({
            reference,
            status: "ready",
            uploadToken: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(nativeProviderArtifacts.companyId, input.owner.companyId),
              eq(nativeProviderArtifacts.id, selected.id),
              eq(nativeProviderArtifacts.uploadToken, uploadToken),
              eq(nativeProviderArtifacts.status, "pending"),
            ),
          )
          .returning({ id: nativeProviderArtifacts.id });
        if (rows.length)
          await recordRunReceipt(
            tx,
            input.owner,
            receiptFor(selected.id, closureDigest, input.source),
          );
        return rows[0]?.id ?? null;
      });
      if (!published) {
        await input.storage.deleteObject(
          input.owner.companyId,
          reference.objectKey,
          { allVersions: true, signal: input.signal },
        );
        fail("owner_changed");
      }
      if (published !== selected.id) {
        await input.storage.deleteObject(
          input.owner.companyId,
          reference.objectKey,
          { allVersions: true, signal: input.signal },
        );
        await input.db.transaction(async (tx) => {
          await tx
            .delete(nativeProviderArtifactReferences)
            .where(
              and(
                eq(
                  nativeProviderArtifactReferences.companyId,
                  input.owner.companyId,
                ),
                eq(nativeProviderArtifactReferences.artifactId, selected.id),
              ),
            );
          await tx
            .delete(nativeProviderArtifacts)
            .where(
              and(
                eq(nativeProviderArtifacts.companyId, input.owner.companyId),
                eq(nativeProviderArtifacts.id, selected.id),
                eq(nativeProviderArtifacts.status, "pending"),
              ),
            );
        });
        selected.id = published;
      }
    }
    return receiptFor(selected.id, closureDigest, input.source);
  } finally {
    key.fill(0);
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function retainExistingNativeProviderArtifacts(input: {
  db: Db;
  owner: NativeRunnerCheckpointFenceOwner;
  receipt: NativeProviderArtifactReceipt;
}) {
  manifestIdentity(input.receipt.manifest);
  launchRootIdentity(
    input.receipt.launchRoot,
    input.receipt.manifest,
    input.receipt.accountUid,
  );
  if (
    input.receipt.schema !== schema ||
    input.receipt.providerPackDigest !== input.receipt.manifest.digest
  )
    fail("receipt_invalid");
  await input.db.transaction(async (tx) => {
    await artifactOwnerFence(tx, input.owner, input.receipt.manifest);
    const [row] = await tx
      .select()
      .from(nativeProviderArtifacts)
      .where(
        and(
          eq(nativeProviderArtifacts.companyId, input.owner.companyId),
          eq(nativeProviderArtifacts.id, input.receipt.artifactId),
          eq(
            nativeProviderArtifacts.closureDigest,
            input.receipt.closureDigest,
          ),
          eq(nativeProviderArtifacts.status, "ready"),
        ),
      )
      .for("update");
    if (
      !row ||
      digest(canonicalProviderPackJson(row.descriptor)) !==
        input.receipt.closureDigest
    )
      fail("unavailable");
    descriptorIdentity(row.descriptor as Descriptor, input.receipt);
    await tx
      .insert(nativeProviderArtifactReferences)
      .values({
        companyId: input.owner.companyId,
        artifactId: row.id,
        runId: input.owner.runId,
      })
      .onConflictDoNothing();
    await recordRunReceipt(tx, input.owner, input.receipt);
  });
}

export async function restoreNativeProviderArtifacts(input: {
  db: Db;
  storage: StorageService;
  companyId: string;
  receipt: NativeProviderArtifactReceipt;
  targetRoot: string;
  signal?: AbortSignal;
}) {
  const receipt = input.receipt;
  if (receipt?.schema !== schema || !validDigest(receipt.closureDigest))
    fail("receipt_invalid");
  manifestIdentity(receipt.manifest);
  launchRootIdentity(receipt.launchRoot, receipt.manifest, receipt.accountUid);
  if (receipt.providerPackDigest !== receipt.manifest.digest)
    fail("receipt_invalid");
  const [row] = await input.db
    .select()
    .from(nativeProviderArtifacts)
    .where(
      and(
        eq(nativeProviderArtifacts.companyId, input.companyId),
        eq(nativeProviderArtifacts.id, receipt.artifactId),
        eq(nativeProviderArtifacts.closureDigest, receipt.closureDigest),
        eq(nativeProviderArtifacts.status, "ready"),
      ),
    );
  if (!row?.reference) fail("unavailable");
  const reference = artifactReference(
    row.reference!,
    input.companyId,
    row.id,
    receipt.closureDigest,
  );
  const expectedDescriptor = row.descriptor as Descriptor;
  if (
    digest(canonicalProviderPackJson(expectedDescriptor)) !==
    receipt.closureDigest
  )
    fail("descriptor_invalid");
  descriptorIdentity(expectedDescriptor, receipt);
  if (
    await verifyMaterialized(input.targetRoot, expectedDescriptor, input.signal)
  )
    return;
  const wrapped = JSON.parse(
    createLocalEncryptedCipher("read").decrypt(reference.material),
  );
  if (
    wrapped.schema !== schema ||
    wrapped.companyId !== input.companyId ||
    wrapped.artifactId !== row.id ||
    wrapped.closureDigest !== receipt.closureDigest
  )
    fail("binding_mismatch");
  const key = Buffer.from(wrapped.key, "base64");
  const scratch = await mkdtemp(
    join(tmpdir(), "pc-provider-artifacts-restore-"),
  );
  try {
    if (key.length !== 32) fail("key_invalid");
    const encrypted = join(scratch, "encrypted"),
      archive = join(scratch, "archive"),
      restored = join(scratch, "restored");
    await receive(input.storage, reference, encrypted, input.signal);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(wrapped.iv, "base64"),
    );
    decipher.setAAD(aad(input.companyId, row.id, receipt.closureDigest));
    decipher.setAuthTag(Buffer.from(wrapped.tag, "base64"));
    await pipeline(
      createReadStream(encrypted),
      decipher,
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
      { signal: input.signal },
    );
    const actual = await fileDigest(archive, input.signal);
    if (
      actual.sha256 !== wrapped.plaintext?.sha256 ||
      actual.byteSize !== wrapped.plaintext?.byteSize
    )
      fail("object_changed");
    await restoreNativeHarnessArchive(archive, restored, input.signal);
    const descriptor = await readDescriptor(join(restored, "manifest.json"));
    if (
      digest(canonicalProviderPackJson(descriptor)) !== receipt.closureDigest ||
      canonicalProviderPackJson(descriptor) !==
        canonicalProviderPackJson(row.descriptor)
    )
      fail("descriptor_invalid");
    for (const entry of descriptor.entries) {
      if (
        !names.includes(entry.name) ||
        entry.path !== receipt.manifest.payload.artifacts[entry.name]?.path ||
        entry.sha256 !== receipt.manifest.payload.artifacts[entry.name]?.sha256
      )
        fail("descriptor_invalid");
      const actual = await fileDigest(join(restored, entry.name), input.signal);
      if (actual.sha256 !== entry.sha256 || actual.byteSize !== entry.byteSize)
        fail("object_changed");
    }
    await cp(restored, input.targetRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  } finally {
    key.fill(0);
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function pinNativeProviderArtifactsForBackup(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: {
    companyId: string;
    runId: string;
    backupId: string;
    receipt: NativeProviderArtifactReceipt;
  },
) {
  const [artifact] = await tx
    .select({ id: nativeProviderArtifacts.id })
    .from(nativeProviderArtifacts)
    .where(
      and(
        eq(nativeProviderArtifacts.companyId, input.companyId),
        eq(nativeProviderArtifacts.id, input.receipt.artifactId),
        eq(nativeProviderArtifacts.closureDigest, input.receipt.closureDigest),
        eq(nativeProviderArtifacts.status, "ready"),
      ),
    )
    .for("update");
  if (!artifact) fail("unavailable");
  await tx
    .insert(nativeProviderArtifactReferences)
    .values({
      companyId: input.companyId,
      artifactId: artifact.id,
      runId: input.runId,
      backupId: input.backupId,
    })
    .onConflictDoNothing();
}

export async function releaseRetiredNativeProviderArtifacts(input: {
  db: Db;
  storage: StorageService;
  companyId: string;
  runId: string;
  backupId?: string;
  receipt: Pick<NativeProviderArtifactReceipt, "artifactId" | "closureDigest">;
  signal?: AbortSignal;
}) {
  const deletion = await input.db.transaction(async (tx) => {
    const [owner] = await tx
      .select()
      .from(nativeRunFinalizations)
      .where(
        and(
          eq(nativeRunFinalizations.companyId, input.companyId),
          eq(nativeRunFinalizations.runId, input.runId),
        ),
      )
      .for("share");
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.id, input.runId),
        ),
      )
      .for("share");
    const [artifact] = await tx
      .select()
      .from(nativeProviderArtifacts)
      .where(
        and(
          eq(nativeProviderArtifacts.companyId, input.companyId),
          eq(nativeProviderArtifacts.id, input.receipt.artifactId),
        ),
      )
      .for("update");
    if (!artifact) return null;
    if (artifact.closureDigest !== input.receipt.closureDigest)
      fail("binding_mismatch");
    const leases = await tx
      .select()
      .from(environmentLeases)
      .where(
        and(
          eq(environmentLeases.companyId, input.companyId),
          eq(environmentLeases.heartbeatRunId, input.runId),
        ),
      )
      .limit(101);
    if (
      !run?.finishedAt ||
      ![
        "succeeded",
        "failed",
        "cancelled",
        "interrupted",
        "timed_out",
      ].includes(run.status) ||
      !owner ||
      !["committed", "terminal_failure"].includes(owner.phase) ||
      (owner.leaseOwner &&
        (!owner.leaseExpiresAt || owner.leaseExpiresAt > new Date())) ||
      !leases.length ||
      leases.length > 100 ||
      leases.some((lease) => !hasRemoteTerminationReceipt(lease))
    )
      fail("retained_owner_unsettled");
    const ownedReferences = and(
      eq(nativeProviderArtifactReferences.companyId, input.companyId),
      eq(nativeProviderArtifactReferences.artifactId, artifact.id),
      eq(nativeProviderArtifactReferences.runId, input.runId),
      input.backupId
        ? sql`(${nativeProviderArtifactReferences.backupId} = ${input.backupId}::uuid or ${nativeProviderArtifactReferences.backupId} is null)`
        : sql`${nativeProviderArtifactReferences.backupId} is null`,
    );
    const [retained] = await tx
      .select({ id: nativeProviderArtifactReferences.id })
      .from(nativeProviderArtifactReferences)
      .where(
        and(
          eq(nativeProviderArtifactReferences.companyId, input.companyId),
          eq(nativeProviderArtifactReferences.artifactId, artifact.id),
          not(ownedReferences!),
        ),
      )
      .limit(1);
    if (retained) {
      await tx.delete(nativeProviderArtifactReferences).where(ownedReferences);
      return null;
    }
    const pins = await tx
      .select({ id: nativeProviderArtifactReferences.id })
      .from(nativeProviderArtifactReferences)
      .where(ownedReferences);
    await tx
      .update(nativeProviderArtifacts)
      .set({ status: "retiring", updatedAt: new Date() })
      .where(eq(nativeProviderArtifacts.id, artifact.id));
    return {
      id: artifact.id,
      reference: artifact.reference
        ? artifactReference(
            artifact.reference,
            input.companyId,
            artifact.id,
            artifact.closureDigest,
          )
        : null,
      pins: pins.map((pin) => pin.id),
    };
  });
  if (!deletion) return;
  if (deletion.reference)
    await input.storage.deleteObject(
      input.companyId,
      deletion.reference.objectKey,
      { allVersions: true, signal: input.signal },
    );
  await input.db.transaction(async (tx) => {
    const [artifact] = await tx
      .select({ id: nativeProviderArtifacts.id })
      .from(nativeProviderArtifacts)
      .where(
        and(
          eq(nativeProviderArtifacts.companyId, input.companyId),
          eq(nativeProviderArtifacts.id, deletion.id),
          eq(nativeProviderArtifacts.status, "retiring"),
        ),
      )
      .for("update");
    if (!artifact) return;
    if (deletion.pins.length)
      await tx
        .delete(nativeProviderArtifactReferences)
        .where(
          and(
            eq(nativeProviderArtifactReferences.companyId, input.companyId),
            eq(nativeProviderArtifactReferences.artifactId, artifact.id),
            inArray(nativeProviderArtifactReferences.id, deletion.pins),
          ),
        );
    const [retained] = await tx
      .select({ id: nativeProviderArtifactReferences.id })
      .from(nativeProviderArtifactReferences)
      .where(
        and(
          eq(nativeProviderArtifactReferences.companyId, input.companyId),
          eq(nativeProviderArtifactReferences.artifactId, artifact.id),
        ),
      )
      .limit(1);
    if (retained) fail("retirement_conflict");
    await tx
      .delete(nativeProviderArtifacts)
      .where(eq(nativeProviderArtifacts.id, artifact.id));
  });
}

export async function releaseExpiredNativeProviderArtifactRun(input: {
  db: Db;
  storage: StorageService;
  companyId: string;
  runId: string;
  signal?: AbortSignal;
}) {
  const references = await input.db
    .select({
      artifactId: nativeProviderArtifacts.id,
      closureDigest: nativeProviderArtifacts.closureDigest,
    })
    .from(nativeProviderArtifactReferences)
    .innerJoin(
      nativeProviderArtifacts,
      eq(
        nativeProviderArtifacts.id,
        nativeProviderArtifactReferences.artifactId,
      ),
    )
    .where(
      and(
        eq(nativeProviderArtifactReferences.companyId, input.companyId),
        eq(nativeProviderArtifacts.companyId, input.companyId),
        eq(nativeProviderArtifactReferences.runId, input.runId),
        sql`${nativeProviderArtifactReferences.backupId} is null`,
      ),
    )
    .limit(101);
  if (references.length > 100) fail("retirement_limit");
  for (const receipt of references)
    await releaseRetiredNativeProviderArtifacts({ ...input, receipt });
}
