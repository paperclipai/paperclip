import { execFile } from "node:child_process";
import { open, readFile, rename, stat } from "node:fs/promises";
import { promisify } from "node:util";

export const HISTORY_LIMITS = Object.freeze({
  campaignBytes: 64 * 1024 * 1024,
  campaignFiles: 256,
  mutableBytes: 16 * 1024 * 1024,
  pagesBytes: 64 * 1024 * 1024,
  jsonBytes: 4 * 1024 * 1024,
  indexDays: 28,
  indexCampaigns: 64,
  requests: 280,
  deadlineMs: 10 * 60_000,
});

export function checkHistoryPayload(
  files: readonly { path: string; bytes: number }[],
  maxBytes: number,
  maxFiles: number,
  label: string,
) {
  let bytes = 0;
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`${label} contains invalid or duplicate file metadata`);
    }
    paths.add(file.path);
    bytes += file.bytes;
  }
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes || files.length > maxFiles) {
    throw new Error(`${label} exceeds the publication boundary (${files.length} files, ${bytes} bytes)`);
  }
  return { files: files.length, bytes };
}

interface LifecycleRule {
  Status?: string;
  Prefix?: string;
  Filter?: { Prefix?: string; And?: { Prefix?: string } };
  Expiration?: { Days?: number; Date?: string; ExpiredObjectDeleteMarker?: boolean };
  NoncurrentVersionExpiration?: { NoncurrentDays?: number; NewerNoncurrentVersions?: number };
  AbortIncompleteMultipartUpload?: { DaysAfterInitiation?: number };
  Transitions?: unknown[];
  NoncurrentVersionTransitions?: unknown[];
}

export function validateBoundedHistoryRetention(configuration: unknown, prefix: string) {
  const rules = (configuration as { Rules?: LifecycleRule[] })?.Rules;
  if (!Array.isArray(rules) || !prefix.endsWith("/bounded-v1")) {
    throw new Error("Bounded history requires an isolated bounded-v1 prefix and lifecycle rules");
  }
  const scoped = rules.filter(rule => rule.Status === "Enabled" &&
    rule.Filter?.Prefix === `${prefix}/` && Object.keys(rule.Filter).length === 1);
  const retention = scoped.some(rule => rule.Expiration?.Days === 30 &&
    rule.NoncurrentVersionExpiration?.NoncurrentDays === 1 &&
    rule.NoncurrentVersionExpiration?.NewerNoncurrentVersions === undefined &&
    rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 1);
  const markers = scoped.some(rule => rule.Expiration?.ExpiredObjectDeleteMarker === true);
  if (!retention || !markers) {
    throw new Error("Bounded history needs 30-day current, 1-day noncurrent, delete-marker and multipart expiry");
  }
  for (const rule of rules.filter(rule => rule.Status === "Enabled")) {
    const filterPrefix = rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? "";
    if (!`${prefix}/`.startsWith(filterPrefix) && !filterPrefix.startsWith(`${prefix}/`)) continue;
    if (rule.Transitions?.length || rule.NoncurrentVersionTransitions?.length ||
      (rule.Expiration && !scoped.includes(rule))) {
      throw new Error("An overlapping lifecycle rule changes bounded history retention or storage class");
    }
    if (rule.Expiration?.Days !== undefined && rule.Expiration.Days !== 30 || rule.Expiration?.Date) {
      throw new Error("An overlapping lifecycle rule changes bounded history expiration");
    }
  }
}

type AwsRunner = (args: string[], timeout: number) => Promise<{ stdout: string }>;
const execFileAsync = promisify(execFile);
const defaultRunner: AwsRunner = async (args, timeout) => execFileAsync("aws", args, {
  timeout, maxBuffer: 1024 * 1024,
  env: { ...process.env, AWS_MAX_ATTEMPTS: "1", AWS_RETRY_MODE: "standard", AWS_PAGER: "" },
});

function errorDetail(error: unknown) {
  return String((error as { stderr?: string })?.stderr ?? (error instanceof Error ? error.message : error));
}

export class BoundedHistoryPublisher {
  private readonly startedAt = Date.now();
  private readonly observations: Array<{ operation: string; status: string; bucket?: string; key?: string; sourceBytes?: number; versionId?: string; etag?: string }> = [];

  constructor(private readonly receipt: string, private readonly runner: AwsRunner = defaultRunner) {}

  async run(args: string[], sourceBytes?: number) {
    const remaining = HISTORY_LIMITS.deadlineMs - (Date.now() - this.startedAt);
    if (remaining <= 0 || this.observations.length >= HISTORY_LIMITS.requests) {
      throw new Error("Bounded history publisher exhausted its time or request allowance");
    }
    const argument = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const observation: typeof this.observations[number] = { operation: args[1]!, status: "unknown",
      bucket: argument("--bucket"), key: argument("--key"), ...(sourceBytes === undefined ? {} : { sourceBytes }) };
    this.observations.push(observation);
    await this.save();
    try {
      const result = await this.runner([...args, "--cli-connect-timeout", "10", "--cli-read-timeout", "30"], Math.min(30_000, remaining));
      observation.status = "accepted";
      if (observation.operation === "put-object") {
        const response = JSON.parse(result.stdout) as { VersionId?: unknown; ETag?: unknown };
        if (typeof response.VersionId === "string") observation.versionId = response.VersionId.slice(0, 1024);
        if (typeof response.ETag === "string") observation.etag = response.ETag.slice(0, 1024);
      }
      return result;
    } catch (error) {
      observation.status = /\((?:NoSuchKey|404|NotFound|ObjectLockConfigurationNotFoundError|ReplicationConfigurationNotFoundError)\)/.test(errorDetail(error))
        ? "absent" : "failed_or_unknown";
      throw error;
    } finally {
      await this.save();
    }
  }

  async save() {
    const file = await open(`${this.receipt}.tmp`, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify({
      schema: "paperclip.runner-e2e.history-publication/v1",
      startedAt: new Date(this.startedAt).toISOString(), observedAt: new Date().toISOString(),
      workflowRunId: process.env.GITHUB_RUN_ID ?? null, workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      limits: HISTORY_LIMITS, billedUsd: null, requests: this.observations,
      attemptedSourceBytes: this.observations.reduce((sum, entry) => sum + (entry.sourceBytes ?? 0), 0),
      }, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(`${this.receipt}.tmp`, this.receipt);
  }

  async verifyRetention(bucket: string, prefix: string) {
    const config = async (operation: string) => JSON.parse((await this.run(["s3api", operation, "--bucket", bucket])).stdout);
    if ((await config("get-bucket-versioning")).Status !== "Enabled") {
      throw new Error("Bounded history requires versioning-enabled storage");
    }
    validateBoundedHistoryRetention(await config("get-bucket-lifecycle-configuration"), prefix);
    for (const [operation, absence] of [
      ["get-object-lock-configuration", "ObjectLockConfigurationNotFoundError"],
      ["get-bucket-replication", "ReplicationConfigurationNotFoundError"],
    ]) {
      try {
        await config(operation!);
      } catch (error) {
        if (errorDetail(error).includes(`(${absence})`)) continue;
        throw error;
      }
      throw new Error(`Bounded history cannot prove expiration with ${operation} configured`);
    }
  }

  async downloadJson<T>(bucket: string, key: string, destination: string): Promise<T | null> {
    try {
      await this.run(["s3api", "get-object", "--bucket", bucket, "--key", key,
        "--range", `bytes=0-${HISTORY_LIMITS.jsonBytes}`, destination]);
    } catch (error) {
      if (/\((?:NoSuchKey|404|NotFound)\)/.test(errorDetail(error))) return null;
      throw error;
    }
    if ((await stat(destination)).size > HISTORY_LIMITS.jsonBytes) throw new Error("History JSON exceeds the read boundary");
    return JSON.parse(await readFile(destination, "utf8")) as T;
  }

  async upload(bucket: string, key: string, file: string, contentType: string, cacheControl: string, immutable = false) {
    const bytes = (await stat(file)).size;
    return this.run(["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", file,
      "--content-length", String(bytes), "--content-type", contentType, "--cache-control", cacheControl,
      "--storage-class", "STANDARD", ...(immutable ? ["--if-none-match", "*"] : [])], bytes);
  }
}
