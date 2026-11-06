import {
  schema,
  names,
  MAX_NATIVE_PROVIDER_ARTIFACT_BYTES,
  digest,
  fail,
  aad,
  validDigest,
  receiptFor,
  manifestIdentity,
  launchRootIdentity,
  descriptorIdentity,
  fileDigest,
  readDescriptor,
  artifactReference,
  verifyMaterialized,
  capture,
  receive,
  type Descriptor,
  type BlobReference,
  type NativeProviderArtifactSource,
  type NativeProviderArtifactReceipt,
} from "./native-provider-artifact-files.js";
export {
  MAX_NATIVE_PROVIDER_ARTIFACT_BYTES,
  type NativeProviderArtifactSource,
  type NativeProviderArtifactReceipt,
} from "./native-provider-artifact-files.js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const staging = `${input.targetRoot}.${randomUUID()}.pending`;
    try {
      await cp(restored, staging, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await verifyMaterialized(staging, expectedDescriptor, input.signal);
      input.signal?.throwIfAborted();
      try {
        await rename(staging, input.targetRoot);
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        if (
          !(await verifyMaterialized(
            input.targetRoot,
            expectedDescriptor,
            input.signal,
          ))
        )
          throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
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
