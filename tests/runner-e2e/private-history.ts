import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { BoundedHistoryPublisher } from "./history-budget.js";

const execFileAsync = promisify(execFile);
export const PRIVATE_HISTORY_PREFIX = "runner-e2e-private/bounded-v1";
export const PRIVATE_ARCHIVE_BYTES = 264 * 1024 * 1024;

export function privateArtifactKey(kind: string, runId: string) {
  if (!(["evidence", "report", "protocol-control", "protocol-report"].includes(kind)
      || /^protocol-cell-[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(kind)
      || /^manual-cell-[0-9a-f]{64}$/.test(kind) || kind === "manual-report") || !/^[1-9][0-9]{0,19}$/.test(runId)) {
    throw new Error("Private history needs a supported artifact kind and numeric workflow run ID");
  }
  return `${PRIVATE_HISTORY_PREFIX}/campaigns/gha-${runId}-1/${kind}.zip`;
}

export async function archivePrivateEvidence(operation: "pack" | "unpack", source: string, destination: string) {
  const result = await execFileAsync("python3", [path.join(import.meta.dirname, "private-history-archive.py"), operation, source, destination], {
    timeout: 60_000, maxBuffer: 64 * 1024,
  });
  return JSON.parse(result.stdout) as { files: number; sourceBytes: number; archiveBytes?: number };
}

export async function verifyPrivateHistory(publisher: BoundedHistoryPublisher, bucket: string) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Invalid private history bucket");
  await publisher.verifyRetention(bucket, PRIVATE_HISTORY_PREFIX);
  const configuration = async (operation: string) => JSON.parse((await publisher.run(["s3api", operation, "--bucket", bucket])).stdout);
  const block = (await configuration("get-public-access-block")).PublicAccessBlockConfiguration;
  if (!["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].every(key => block?.[key] === true)) {
    throw new Error("Private history requires all bucket public-access blocks");
  }
  const ownership = (await configuration("get-bucket-ownership-controls")).OwnershipControls?.Rules;
  if (!Array.isArray(ownership) || ownership.length !== 1 || ownership[0]?.ObjectOwnership !== "BucketOwnerEnforced") {
    throw new Error("Private history requires disabled object ACLs");
  }
  const policy = JSON.parse((await configuration("get-bucket-policy")).Policy);
  if (!Array.isArray(policy.Statement) || policy.Statement.some((statement: { Effect?: string }) => statement.Effect !== "Deny")) {
    throw new Error("Private history bucket policy must not grant access to external readers or a CDN");
  }
}

export interface PrivateEvidenceCompleteness {
  meaning: "available-files-and-transfer-only";
  doesNotAttestFeatureOutcome: true;
  cells: Array<{ executionId: string; availableFileInventoryComplete: true; requiredPassEvidenceComplete: boolean | null; missingRequiredEvidence: string[] }>;
}

type TransferOptions = {
  operation: "upload" | "download";
  kind: string;
  runId: string;
  directory: string;
  bucket: string;
  publisher: BoundedHistoryPublisher;
  receiptIdentity?: string;
  evidenceCompleteness?: PrivateEvidenceCompleteness;
};

function privateTransferReceiptKey(options: TransferOptions) {
  const key = privateArtifactKey(options.kind, options.runId);
  if (options.receiptIdentity !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(options.receiptIdentity)) {
    throw new Error("Invalid private transfer receipt identity");
  }
  const identity = options.receiptIdentity === undefined ? "" : `.${createHash("sha256").update(options.receiptIdentity).digest("hex")}`;
  return `${key}.${options.operation}${identity}-receipt.json`;
}

export async function transferPrivateArtifact(options: TransferOptions) {
  privateArtifactKey(options.kind, options.runId);
  await verifyPrivateHistory(options.publisher, options.bucket);
  return transferVerifiedArtifact(options);
}

async function transferVerifiedArtifact(options: TransferOptions) {
  const key = privateArtifactKey(options.kind, options.runId);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "paperclip-private-history-"));
  const archive = path.join(temporary, "archive.zip");
  try {
    if (options.operation === "upload") {
      const metadata = await archivePrivateEvidence("pack", options.directory, archive);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(archive)) hash.update(chunk);
      const result = await options.publisher.upload(options.bucket, key, archive, "application/zip", "private, no-store", true);
      const response = JSON.parse(result.stdout) as { VersionId?: string };
      if (!response.VersionId) throw new Error("Private archive upload did not return a version identity");
      return { private: true, ...metadata, uri: `s3://${options.bucket}/${key}`, versionId: response.VersionId, sha256: hash.digest("hex") };
    }
    await options.publisher.run(["s3api", "get-object", "--bucket", options.bucket, "--key", key,
      "--range", `bytes=0-${PRIVATE_ARCHIVE_BYTES}`, archive]);
    if ((await lstat(archive)).size > PRIVATE_ARCHIVE_BYTES) throw new Error("Private archive exceeds transfer allowance");
    const metadata = await archivePrivateEvidence("unpack", archive, options.directory);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    return { ...metadata, uri: `s3://${options.bucket}/${key}`, sha256: hash.digest("hex") };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function retainPrivateTransfer(options: TransferOptions, receipt: string, receiptPublisher?: () => BoundedHistoryPublisher) {
  const receiptKey = privateTransferReceiptKey(options);
  await verifyPrivateHistory(options.publisher, options.bucket);
  let result: Awaited<ReturnType<typeof transferVerifiedArtifact>> | undefined;
  let failure: unknown;
  try {
    result = await transferVerifiedArtifact(options);
  } catch (error) {
    failure = error;
  }
  if (receiptPublisher) {
    await options.publisher.save();
    const snapshot = JSON.stringify({ ...JSON.parse(await readFile(receipt, "utf8")),
      ...(options.receiptIdentity === undefined ? {} : { receiptIdentity: options.receiptIdentity }),
      ...(options.evidenceCompleteness === undefined ? {} : { evidenceCompleteness: options.evidenceCompleteness }),
      transfer: result ? { status: "complete", ...result } : { status: "failed_or_unknown" },
      receiptUpload: { status: "pending_at_snapshot", maxBytes: 1024 * 1024 } });
    if (Buffer.byteLength(snapshot) > 1024 * 1024) throw new Error("Private transfer receipt exceeds allowance");
    await writeFile(`${receipt}.transfer.json`, snapshot, { mode: 0o600, flag: "wx" });
    try {
      await receiptPublisher().upload(options.bucket, receiptKey, `${receipt}.transfer.json`, "application/json", "private, no-store", true);
    } catch (retentionError) {
      throw new AggregateError(failure ? [failure, retentionError] : [retentionError], "Private transfer receipt retention failed; local receipts remain authoritative");
    }
  }
  if (failure) throw failure;
  return result!;
}

async function main() {
  const [operation, kind, runId, directory, receiptIdentity] = process.argv.slice(2);
  if (!["verify", "upload", "download"].includes(operation ?? "") || !kind || !runId || !directory) {
    throw new Error("Usage: private-history.ts verify|upload|download KIND RUN_ID DIRECTORY [RECEIPT_ID]");
  }
  privateArtifactKey(kind, runId);
  if (receiptIdentity !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(receiptIdentity)
      || kind === "protocol-control" && operation === "download" && !receiptIdentity || process.argv.length > 7) {
    throw new Error("Shared protocol downloads require a bounded unique receipt identity");
  }
  if (process.env.GITHUB_ACTIONS === "true" && (process.env.GITHUB_RUN_ATTEMPT !== "1" || process.env.GITHUB_RUN_ID !== runId)) {
    throw new Error("Private bounded history accepts only the initial attempt of this workflow run");
  }
  const bucket = process.env.RUNNER_E2E_PRIVATE_HISTORY_S3_BUCKET ?? "";
  const label = kind.startsWith("protocol-") ? createHash("sha256").update(`${kind}:${receiptIdentity ?? ""}`).digest("hex") : kind;
  const receipt = path.resolve(`private-history-${operation}-${label}-${runId}.json`);
  await (await open(receipt, "wx", 0o600)).close();
  const publisher = new BoundedHistoryPublisher(receipt);
  if (operation === "verify") {
    await verifyPrivateHistory(publisher, bucket);
    console.log("Private retention and access checks passed");
    return;
  }
  const receiptPublisher = operation === "upload" || process.env.GITHUB_ACTIONS === "true"
    ? () => new BoundedHistoryPublisher(`${receipt}.retention.json`) : undefined;
  const result = await retainPrivateTransfer({ operation: operation as "upload" | "download", kind, runId, directory, bucket, publisher, receiptIdentity }, receipt, receiptPublisher);
  console.log(JSON.stringify(process.env.GITHUB_ACTIONS === "true" ? { version: 1, privateTransferCompleted: true } : result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(process.env.GITHUB_ACTIONS === "true" ? "Private history transfer failed; inspect private retained evidence." : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
