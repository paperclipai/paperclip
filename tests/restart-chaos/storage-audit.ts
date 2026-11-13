import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Db } from "../../packages/db/src/index.js";
import type { ObjectStore } from "./object-store.js";

type StoreAccess = Pick<ObjectStore, "endpoint" | "bucket" | "region" | "accessKeyId" | "secretAccessKey">;

export interface IncompleteUpload { key: string; uploadId: string; initiated: string | null }
export interface SnapshotProblem { id: string; objectKey: string; problem: string }
export interface CommittedSnapshot { id: string; objectKey: string | null; sha256: string | null; byteSize: number | null }
export interface StorageAudit {
  incompleteUploads: IncompleteUpload[];
  committedSnapshots: number;
  snapshotProblems: SnapshotProblem[];
  snapshotsChecked: boolean;
  unexercisedFaults: string[];
  errors: string[];
}

export function unexercisedFaults(kinds: readonly string[], injectedBy: Record<string, number> = {}): string[] {
  const hit = (prefixes: readonly string[]) => Object.entries(injectedBy).some(([cause, count]) => count > 0 && prefixes.some(prefix => cause.startsWith(prefix)));
  return [...new Set(kinds)].filter(kind =>
    (kind === "ST4" && !hit(["UploadPart:", "CompleteMultipartUpload:"]))
    || (kind === "ST7" && !hit(["GetObject:read_after_write_lag", "HeadObject:read_after_write_lag"]))
    || (kind === "ST8" && !hit(["PutObject:throttle", "UploadPart:throttle"])));
}

export const AUDITED_STORAGE_FAULTS = ["ST4", "ST7", "ST8"] as const;

export function auditsStorage(options: { storage?: string; storageFaults?: readonly string[];
  storageWindows?: ReadonlyArray<{ kind: string }> }): boolean {
  if (options.storage !== "s3") return false;
  const kinds = [...(options.storageFaults ?? []), ...(options.storageWindows ?? []).map(window => window.kind)];
  return kinds.some(kind => (AUDITED_STORAGE_FAULTS as readonly string[]).includes(kind));
}

function s3Client(store: StoreAccess) {
  const sdk = createRequire(new URL("../../server/package.json", import.meta.url))("@aws-sdk/client-s3");
  const client = new sdk.S3Client({ endpoint: store.endpoint, region: store.region, forcePathStyle: true,
    credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey } });
  return { sdk, client };
}

export function storedKey(prefix: string, objectKey: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/${objectKey}` : objectKey;
}

export async function listIncompleteUploads(store: StoreAccess, prefix: string): Promise<IncompleteUpload[]> {
  const { sdk, client } = s3Client(store);
  const uploads: IncompleteUpload[] = [];
  try {
    let keyMarker: string | undefined, uploadIdMarker: string | undefined;
    for (;;) {
      const page = await client.send(new sdk.ListMultipartUploadsCommand({ Bucket: store.bucket,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}), ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}) }));
      for (const upload of page.Uploads ?? []) {
        if (!String(upload.Key).startsWith(prefix)) continue;
        uploads.push({ key: String(upload.Key), uploadId: String(upload.UploadId),
          initiated: upload.Initiated ? new Date(upload.Initiated).toISOString() : null });
      }
      if (!page.IsTruncated) return uploads;
      keyMarker = page.NextKeyMarker; uploadIdMarker = page.NextUploadIdMarker;
      if (!keyMarker && !uploadIdMarker) return uploads;
    }
  } finally { client.destroy(); }
}

export async function checkCommittedSnapshots(store: StoreAccess, prefix: string,
  snapshots: readonly CommittedSnapshot[]): Promise<SnapshotProblem[]> {
  const { sdk, client } = s3Client(store);
  const problems: SnapshotProblem[] = [];
  try {
    for (const snapshot of snapshots) {
      const objectKey = snapshot.objectKey ?? "";
      const fail = (problem: string) => problems.push({ id: snapshot.id, objectKey, problem });
      if (!snapshot.objectKey || !snapshot.sha256 || snapshot.byteSize === null) { fail("committed_without_object"); continue; }
      try {
        const object = await client.send(new sdk.GetObjectCommand({ Bucket: store.bucket, Key: storedKey(prefix, snapshot.objectKey) }));
        const digest = createHash("sha256");
        let size = 0;
        for await (const chunk of object.Body as Readable) { size += (chunk as Buffer).length; digest.update(chunk as Buffer); }
        if (size !== snapshot.byteSize) fail(`size ${size} != ${snapshot.byteSize}`);
        else if (digest.digest("hex") !== snapshot.sha256) fail("sha256_mismatch");
      } catch (error) {
        const name = (error as { name?: string }).name;
        fail(name === "NoSuchKey" || name === "NotFound" ? "object_missing" : `read_failed: ${String(error)}`);
      }
    }
  } finally { client.destroy(); }
  return problems;
}

export function storageAuditFailures(audit: StorageAudit): string[] {
  return [
    ...audit.incompleteUploads.map(upload => `orphaned multipart upload ${upload.key} (${upload.uploadId}, initiated ${upload.initiated ?? "unknown"})`),
    ...audit.snapshotProblems.map(problem => `committed snapshot ${problem.id} does not restore: ${problem.problem}`),
    ...audit.unexercisedFaults.map(kind => `storage fault ${kind} never changed a request: the wave did not test it`),
    ...(audit.snapshotsChecked ? [] : ["storage audit incomplete: committed snapshots were not checked"]),
    ...audit.errors.map(error => `storage audit incomplete: ${error}`),
  ];
}

export function storageAuditMarkdown(audit: StorageAudit): string {
  const failures = storageAuditFailures(audit);
  return [`## Storage audit`, "",
    `Incomplete multipart uploads after the server stopped: ${audit.incompleteUploads.length}.`,
    audit.snapshotsChecked ? `Committed workspace snapshots read back: ${audit.committedSnapshots}, problems: ${audit.snapshotProblems.length}.`
      : "Committed workspace snapshots: not checked.",
    `Storage faults that never changed a request: ${audit.unexercisedFaults.join(", ") || "none"}.`,
    ...(failures.length ? ["", ...failures.map(failure => `- ${failure}`)] : []), ""].join("\n");
}

export async function readCommittedSnapshots(db: Db, companyId: string): Promise<CommittedSnapshot[]> {
  const rows = await db.$client.unsafe(
    `select id, object_key, sha256, byte_size from execution_workspace_snapshots where company_id = $1 and status = 'committed' order by created_at`,
    [companyId]);
  return rows.map(row => ({ id: String(row.id), objectKey: row.object_key === null ? null : String(row.object_key),
    sha256: row.sha256 === null ? null : String(row.sha256), byteSize: row.byte_size === null ? null : Number(row.byte_size) }));
}

export class StorageAuditor {
  readonly audit: StorageAudit = { incompleteUploads: [], committedSnapshots: 0, snapshotProblems: [], snapshotsChecked: false, unexercisedFaults: [], errors: [] };

  constructor(private readonly store: StoreAccess, private readonly prefix: string) {}

  async checkSnapshots(db: Db, companyId: string): Promise<void> {
    try {
      const snapshots = await readCommittedSnapshots(db, companyId);
      this.audit.committedSnapshots = snapshots.length;
      this.audit.snapshotProblems = await checkCommittedSnapshots(this.store, this.prefix, snapshots);
      this.audit.snapshotsChecked = true;
    } catch (error) { this.audit.errors.push(`snapshots: ${String(error)}`); }
  }

  async finish(waveDir: string, exercised: { kinds: readonly string[]; injectedBy?: Record<string, number> }): Promise<string[]> {
    this.audit.unexercisedFaults = unexercisedFaults(exercised.kinds, exercised.injectedBy);
    try { this.audit.incompleteUploads = await listIncompleteUploads(this.store, this.prefix); }
    catch (error) { this.audit.errors.push(`multipart uploads: ${String(error)}`); }
    await writeFile(path.join(waveDir, "storage-audit.json"), `${JSON.stringify(this.audit, null, 2)}\n`, { mode: 0o600 });
    return storageAuditFailures(this.audit);
  }
}
