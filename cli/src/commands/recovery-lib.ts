import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { desc, eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import {
  assets,
  createDb,
  runDatabaseRestore,
  type Db,
} from "@paperclipai/db";
import {
  DEFAULT_RECOVERY_STATUS_FILE,
  evaluateRecoveryStatus,
  type RecoveryAssetCutoverStatus,
  type RecoveryBackupArtifact,
  type RecoveryBackupTier,
  type RecoveryDrillRecord,
  type RecoveryManifestRecord,
  type RecoveryStatusFile,
  type RecoveryStatusSnapshot,
  type RecoveryVaultSummary,
  type StorageProvider,
  type PaperclipConfig,
} from "@paperclipai/shared";
import {
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolveDefaultRecoveryStatusPath,
  resolvePaperclipInstanceId,
} from "../config/home.js";
import { readConfig, writeConfig } from "../config/store.js";

const RECOVERY_STATUS_FILE_VERSION = 1;
const DEFAULT_BACKUP_FILENAME_PREFIX = "paperclip";
const RECOVERY_KEY_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const RECOVERY_ASSET_SAMPLE_LIMIT = 5;
const RECOVERY_ASSET_PROVIDER_UPDATE_BATCH_SIZE = 500;

type RecoveryS3Config = RecoveryVaultSummary & {
  forcePathStyle: boolean;
};

type S3HeadResult = {
  exists: boolean;
  contentLength: number | null;
};

type RecoveryLocalAssetRow = typeof assets.$inferSelect;

type LocalEncryptedSecretMaterial = {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
};

type RecoveryAssetProofSnapshot = {
  remainingLocalAssetCount: number;
  sampleObjectKeys: string[];
};

export interface RecoveryStatusContext {
  config: PaperclipConfig;
  vault: RecoveryVaultSummary | null;
}

export interface PublishRecoveryResult {
  status: RecoveryStatusSnapshot;
  manifest: RecoveryManifestRecord;
  statusPath: string;
}

export interface AssetCutoverResult {
  status: RecoveryStatusSnapshot;
  statusPath: string;
  migratedAssets: number;
  migratedBytes: number;
  skippedAssets: number;
  switchedProvider: boolean;
}

export interface RecoveryDrillResult {
  status: RecoveryStatusSnapshot;
  drill: RecoveryDrillRecord;
  statusPath: string;
}

type RecoveryVaultWriter = {
  putObject(input: {
    objectKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<{
    objectKey: string;
    sizeBytes: number;
    sha256: string;
    uploadedAt: string;
  }>;
};

type PublishRecoveryArtifactsInput = {
  writer: RecoveryVaultWriter;
  now: Date;
  previousManifest: RecoveryManifestRecord | null;
  backupFilePath: string;
  backupBuffer: Buffer;
  backupSha256: string;
  backupCreatedAt: string | null;
  storageProvider: StorageProvider;
  assetCutoverComplete: boolean;
  assetSampleKeys: string[];
  keySnapshotBuffer: Buffer | null;
  keySnapshotFingerprint: string | null;
  configSnapshotBuffer: Buffer;
  warnings: string[];
};

function resolveConnectionString(configPath?: string): string {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return envUrl;

  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return config.database.connectionString.trim();
  }

  const port = config?.database.embeddedPostgresPort ?? 54329;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

function normalizePrefix(prefix: string | null | undefined): string {
  return (prefix ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildObjectKey(prefix: string, objectKey: string): string {
  return prefix ? `${prefix}/${objectKey}` : objectKey;
}

function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function deriveBackupTiers(now: Date, previousManifestCreatedAt: string | null): RecoveryBackupTier[] {
  const tiers: RecoveryBackupTier[] = ["hourly"];
  const previous = previousManifestCreatedAt ? new Date(previousManifestCreatedAt) : null;
  if (!previous || Number.isNaN(previous.getTime()) || previous.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
    tiers.push("daily");
  }
  if (!previous || Number.isNaN(previous.getTime()) || isoWeekKey(previous) !== isoWeekKey(now)) {
    tiers.push("weekly");
  }
  if (!previous || Number.isNaN(previous.getTime()) || monthKey(previous) !== monthKey(now)) {
    tiers.push("monthly");
  }
  return tiers;
}

function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size < 1) {
    throw new Error(`Invalid chunk size: ${size}`);
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function timestampId(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function deriveEncryptionKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function canSkipRemoteAssetUpload(input: {
  remoteBody: Buffer;
  expectedSha256: string;
  expectedByteSize: number;
}): boolean {
  return input.remoteBody.length === input.expectedByteSize && sha256(input.remoteBody) === input.expectedSha256;
}

export function deriveRecoveryManifestAssetProof(input: {
  storageProvider: StorageProvider;
  remainingLocalAssetCount: number;
  sampleObjectKeys: string[];
}): {
  assetCutoverComplete: boolean;
  assetSampleKeys: string[];
} {
  return {
    assetCutoverComplete:
      input.storageProvider === "s3" &&
      input.remainingLocalAssetCount === 0 &&
      input.sampleObjectKeys.length > 0,
    assetSampleKeys: input.sampleObjectKeys,
  };
}

export function detectConcurrentLocalAssetIds(
  migratedAssetIds: Iterable<string>,
  currentLocalAssets: Array<{ id: string }>,
): string[] {
  const migrated = new Set(migratedAssetIds);
  return currentLocalAssets
    .map((asset) => asset.id)
    .filter((assetId) => !migrated.has(assetId));
}

export function decodeLocalEncryptedMasterKeyFile(raw: Buffer | string): Buffer {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Recovered secrets master key file is empty.");
  }

  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // ignored
  }

  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }

  throw new Error("Recovered secrets master key file is not a valid 32-byte key.");
}

function asLocalEncryptedSecretMaterial(material: Record<string, unknown>): LocalEncryptedSecretMaterial {
  if (
    material.scheme === "local_encrypted_v1" &&
    typeof material.iv === "string" &&
    typeof material.tag === "string" &&
    typeof material.ciphertext === "string"
  ) {
    return material as LocalEncryptedSecretMaterial;
  }
  throw new Error("Secret material is not valid local_encrypted_v1 data.");
}

export function decryptLocalEncryptedSecretMaterial(
  masterKeyFileContents: Buffer | string,
  material: Record<string, unknown>,
): string {
  const masterKey = decodeLocalEncryptedMasterKeyFile(masterKeyFileContents);
  const parsed = asLocalEncryptedSecretMaterial(material);
  const decipher = createDecipheriv(
    RECOVERY_KEY_ENCRYPTION_ALGORITHM,
    masterKey,
    Buffer.from(parsed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function verifyRecoveredLocalEncryptedSecretValue(input: {
  masterKeyFileContents: Buffer | string;
  material: Record<string, unknown>;
  valueSha256: string;
}): string {
  const plaintext = decryptLocalEncryptedSecretMaterial(input.masterKeyFileContents, input.material);
  if (sha256(plaintext) !== input.valueSha256) {
    throw new Error("Recovered secrets master key decrypted secret material, but the plaintext hash did not match.");
  }
  return plaintext;
}

export function getRecoveryDrillAssetProofFailures(
  manifest: Pick<RecoveryManifestRecord, "assetCutoverComplete" | "assetSampleKeys">,
): string[] {
  const failures: string[] = [];
  if (!manifest.assetCutoverComplete) {
    failures.push("Recovery manifest was published before asset cutover completed.");
  }
  if (manifest.assetSampleKeys.length === 0) {
    failures.push("Recovery manifest does not include any asset sample keys to verify.");
  }
  return failures;
}

export function encryptRecoveryKeySnapshot(secret: string, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(RECOVERY_KEY_ENCRYPTION_ALGORITHM, deriveEncryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    JSON.stringify({
      version: 1,
      alg: RECOVERY_KEY_ENCRYPTION_ALGORITHM,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }),
    "utf8",
  );
}

export function decryptRecoveryKeySnapshot(secret: string, payload: Buffer): Buffer {
  const parsed = JSON.parse(payload.toString("utf8")) as {
    iv?: string;
    tag?: string;
    ciphertext?: string;
  };
  if (!parsed.iv || !parsed.tag || !parsed.ciphertext) {
    throw new Error("Invalid encrypted recovery key snapshot payload.");
  }
  const decipher = createDecipheriv(
    RECOVERY_KEY_ENCRYPTION_ALGORITHM,
    deriveEncryptionKey(secret),
    Buffer.from(parsed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
}

function createS3ConfigFromEnv(env: NodeJS.ProcessEnv): RecoveryS3Config | null {
  const bucket = env.PAPERCLIP_RECOVERY_VAULT_BUCKET?.trim();
  const region = env.PAPERCLIP_RECOVERY_VAULT_REGION?.trim();
  if (!bucket && !region) return null;
  if (!bucket || !region) {
    throw new Error("Recovery vault requires both PAPERCLIP_RECOVERY_VAULT_BUCKET and PAPERCLIP_RECOVERY_VAULT_REGION.");
  }
  return {
    bucket,
    region,
    endpoint: env.PAPERCLIP_RECOVERY_VAULT_ENDPOINT?.trim() || null,
    prefix: normalizePrefix(env.PAPERCLIP_RECOVERY_VAULT_PREFIX),
    forcePathStyle: env.PAPERCLIP_RECOVERY_VAULT_FORCE_PATH_STYLE === "true",
  };
}

function createRecoveryAssetCheckConfig(
  config: PaperclipConfig,
  env: NodeJS.ProcessEnv,
): RecoveryS3Config | null {
  const bucket = env.PAPERCLIP_RECOVERY_ASSET_BUCKET?.trim();
  const region = env.PAPERCLIP_RECOVERY_ASSET_REGION?.trim();
  if (bucket || region) {
    if (!bucket || !region) {
      throw new Error("Recovery asset verification requires both PAPERCLIP_RECOVERY_ASSET_BUCKET and PAPERCLIP_RECOVERY_ASSET_REGION.");
    }
    return {
      bucket,
      region,
      endpoint: env.PAPERCLIP_RECOVERY_ASSET_ENDPOINT?.trim() || null,
      prefix: normalizePrefix(env.PAPERCLIP_RECOVERY_ASSET_PREFIX),
      forcePathStyle: env.PAPERCLIP_RECOVERY_ASSET_FORCE_PATH_STYLE === "true",
    };
  }

  if (config.storage.provider !== "s3") {
    return null;
  }

  return {
    bucket: config.storage.s3.bucket,
    region: config.storage.s3.region,
    endpoint: config.storage.s3.endpoint ?? null,
    prefix: normalizePrefix(config.storage.s3.prefix),
    forcePathStyle: config.storage.s3.forcePathStyle ?? false,
  };
}

function createS3Client(config: RecoveryS3Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle,
  });
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  const candidate = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };

  if (typeof candidate.transformToByteArray === "function") {
    return Buffer.from(await candidate.transformToByteArray());
  }

  if (typeof candidate.arrayBuffer === "function") {
    return Buffer.from(await candidate.arrayBuffer());
  }

  if (typeof candidate.transformToWebStream === "function") {
    const reader = candidate.transformToWebStream().getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }

  throw new Error("Unsupported S3 body type.");
}

async function putS3Object(
  client: S3Client,
  config: RecoveryS3Config,
  objectKey: string,
  body: Buffer,
  contentType: string,
): Promise<{ objectKey: string; sizeBytes: number; sha256: string; uploadedAt: string }> {
  const key = buildObjectKey(config.prefix, objectKey);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.length,
    }),
  );

  return {
    objectKey,
    sizeBytes: body.length,
    sha256: sha256(body),
    uploadedAt: new Date().toISOString(),
  };
}

async function getS3ObjectBuffer(client: S3Client, config: RecoveryS3Config, objectKey: string): Promise<Buffer> {
  const key = buildObjectKey(config.prefix, objectKey);
  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }),
  );
  return bodyToBuffer(response.Body);
}

async function headS3Object(client: S3Client, config: RecoveryS3Config, objectKey: string): Promise<S3HeadResult> {
  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: buildObjectKey(config.prefix, objectKey),
      }),
    );

    return {
      exists: true,
      contentLength: response.ContentLength ?? null,
    };
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") {
      return { exists: false, contentLength: null };
    }
    throw error;
  }
}

function readConfigOrThrow(configPath?: string): PaperclipConfig {
  const config = readConfig(configPath);
  if (!config) {
    throw new Error("Paperclip config not found.");
  }
  return config;
}

async function listLocalDiskAssets(connectionString: string): Promise<RecoveryLocalAssetRow[]> {
  return withDb(connectionString, async (db) =>
    db
      .select()
      .from(assets)
      .where(eq(assets.provider, "local_disk")),
  );
}

async function countCurrentLocalDiskAssets(connectionString: string): Promise<number> {
  const current = await listLocalDiskAssets(connectionString);
  return current.length;
}

async function getRecoveryAssetProofSnapshot(
  connectionString: string,
  sampleLimit = RECOVERY_ASSET_SAMPLE_LIMIT,
): Promise<RecoveryAssetProofSnapshot> {
  return withDb(connectionString, async (db) => {
    const [localAssets, sampleAssets] = await Promise.all([
      db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.provider, "local_disk")),
      db
        .select({ objectKey: assets.objectKey })
        .from(assets)
        .where(eq(assets.provider, "s3"))
        .orderBy(desc(assets.createdAt))
        .limit(sampleLimit),
    ]);

    return {
      remainingLocalAssetCount: localAssets.length,
      sampleObjectKeys: sampleAssets.map((asset) => asset.objectKey),
    };
  });
}

export function loadRecoveryVaultSummaryFromEnv(env: NodeJS.ProcessEnv = process.env): RecoveryVaultSummary | null {
  const config = createS3ConfigFromEnv(env);
  if (!config) return null;
  return {
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    prefix: config.prefix,
  };
}

export function resolveRecoveryStatusFilePath(instanceId?: string): string {
  return resolveDefaultRecoveryStatusPath(instanceId ?? resolvePaperclipInstanceId());
}

function mergeRecoveryStatus(raw: unknown): RecoveryStatusFile {
  const base = structuredClone(DEFAULT_RECOVERY_STATUS_FILE);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return base;
  }

  const record = raw as Record<string, unknown>;
  return {
    version: RECOVERY_STATUS_FILE_VERSION,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : base.updatedAt,
    backupIntervalMinutes:
      typeof record.backupIntervalMinutes === "number" && Number.isFinite(record.backupIntervalMinutes)
        ? Math.max(1, Math.trunc(record.backupIntervalMinutes))
        : base.backupIntervalMinutes,
    storageProvider:
      record.storageProvider === "s3" || record.storageProvider === "local_disk"
        ? record.storageProvider
        : base.storageProvider,
    vault:
      record.vault && typeof record.vault === "object"
        ? {
            bucket: String((record.vault as Record<string, unknown>).bucket ?? ""),
            region: String((record.vault as Record<string, unknown>).region ?? ""),
            endpoint:
              (record.vault as Record<string, unknown>).endpoint == null
                ? null
                : String((record.vault as Record<string, unknown>).endpoint),
            prefix: String((record.vault as Record<string, unknown>).prefix ?? ""),
          }
        : null,
    latestUploadedManifest:
      record.latestUploadedManifest && typeof record.latestUploadedManifest === "object"
        ? (record.latestUploadedManifest as RecoveryManifestRecord)
        : null,
    latestDrillAttempt:
      record.latestDrillAttempt && typeof record.latestDrillAttempt === "object"
        ? (record.latestDrillAttempt as RecoveryDrillRecord)
        : null,
    latestVerifiedRestore:
      record.latestVerifiedRestore && typeof record.latestVerifiedRestore === "object"
        ? (record.latestVerifiedRestore as RecoveryDrillRecord)
        : null,
    assetCutover:
      record.assetCutover && typeof record.assetCutover === "object"
        ? {
            lastRunAt:
              (record.assetCutover as Record<string, unknown>).lastRunAt == null
                ? null
                : String((record.assetCutover as Record<string, unknown>).lastRunAt),
            switchedAt:
              (record.assetCutover as Record<string, unknown>).switchedAt == null
                ? null
                : String((record.assetCutover as Record<string, unknown>).switchedAt),
            migratedAssetCount: Number((record.assetCutover as Record<string, unknown>).migratedAssetCount ?? 0) || 0,
            migratedByteCount: Number((record.assetCutover as Record<string, unknown>).migratedByteCount ?? 0) || 0,
            remainingLocalAssetCount:
              Number((record.assetCutover as Record<string, unknown>).remainingLocalAssetCount ?? 0) || 0,
            sampleObjectKeys: Array.isArray((record.assetCutover as Record<string, unknown>).sampleObjectKeys)
              ? ((record.assetCutover as Record<string, unknown>).sampleObjectKeys as string[]).map(String)
              : [],
            lastError:
              (record.assetCutover as Record<string, unknown>).lastError == null
                ? null
                : String((record.assetCutover as Record<string, unknown>).lastError),
          }
        : base.assetCutover,
    warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
  };
}

export async function readRecoveryStatusFile(statusPath = resolveRecoveryStatusFilePath()): Promise<RecoveryStatusFile> {
  try {
    const raw = await fsp.readFile(statusPath, "utf8");
    return mergeRecoveryStatus(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_RECOVERY_STATUS_FILE);
  }
}

export async function writeRecoveryStatusFile(
  status: RecoveryStatusFile,
  statusPath = resolveRecoveryStatusFilePath(),
): Promise<void> {
  await fsp.mkdir(path.dirname(statusPath), { recursive: true });
  await fsp.writeFile(statusPath, JSON.stringify(status, null, 2) + "\n", { mode: 0o600 });
}

export async function getRecoveryStatusSnapshot(
  context: RecoveryStatusContext,
  opts?: { statusPath?: string; now?: Date },
): Promise<RecoveryStatusSnapshot> {
  const base = await readRecoveryStatusFile(opts?.statusPath);
  return evaluateRecoveryStatus({
    ...base,
    backupIntervalMinutes: context.config.database.backup.intervalMinutes,
    storageProvider: context.config.storage.provider,
    vault: context.vault,
  }, opts?.now);
}

function resolveBackupDir(config: PaperclipConfig): string {
  return path.resolve(expandHomePrefix(config.database.backup.dir || resolveDefaultBackupDir(resolvePaperclipInstanceId())));
}

export async function findLatestBackupFile(
  config: PaperclipConfig,
  filenamePrefix = DEFAULT_BACKUP_FILENAME_PREFIX,
): Promise<{ filePath: string; createdAt: string | null }> {
  const backupDir = resolveBackupDir(config);
  const names = await fsp.readdir(backupDir).catch(() => []);
  const candidates = await Promise.all(
    names
      .filter((name) => name.startsWith(`${filenamePrefix}-`) && (name.endsWith(".sql") || name.endsWith(".sql.gz")))
      .map(async (name) => {
        const filePath = path.resolve(backupDir, name);
        const stat = await fsp.stat(filePath);
        return {
          filePath,
          mtimeMs: stat.mtimeMs,
          createdAt: stat.mtime.toISOString(),
        };
      }),
  );

  const latest = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!latest) {
    throw new Error(`No completed backup files were found in ${backupDir}. Run \`paperclipai db:backup\` first.`);
  }

  return {
    filePath: latest.filePath,
    createdAt: latest.createdAt,
  };
}

function buildSanitizedConfigSnapshot(config: PaperclipConfig): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        database: {
          mode: config.database.mode,
          embeddedPostgresDataDir: config.database.embeddedPostgresDataDir,
          embeddedPostgresPort: config.database.embeddedPostgresPort,
          backup: config.database.backup,
        },
        server: {
          deploymentMode: config.server.deploymentMode,
          exposure: config.server.exposure,
          host: config.server.host,
          port: config.server.port,
        },
        storage: {
          provider: config.storage.provider,
          localDisk: config.storage.localDisk,
          s3: {
            bucket: config.storage.s3.bucket,
            region: config.storage.s3.region,
            endpoint: config.storage.s3.endpoint ?? null,
            prefix: config.storage.s3.prefix,
            forcePathStyle: config.storage.s3.forcePathStyle ?? false,
          },
        },
        secrets: {
          provider: config.secrets.provider,
          strictMode: config.secrets.strictMode,
          localEncrypted: {
            keyFilePath: config.secrets.localEncrypted.keyFilePath,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function resolveMasterKeyPath(config: PaperclipConfig): string {
  const override = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE?.trim();
  const configured = override || config.secrets.localEncrypted.keyFilePath;
  return path.resolve(expandHomePrefix(configured));
}

function buildRecoveryWriter(config: RecoveryS3Config): RecoveryVaultWriter {
  const client = createS3Client(config);
  return {
    async putObject(input) {
      return putS3Object(client, config, input.objectKey, input.body, input.contentType);
    },
  };
}

export async function publishRecoveryArtifacts(input: PublishRecoveryArtifactsInput): Promise<RecoveryManifestRecord> {
  const manifestId = randomUUID();
  const createdAt = input.now.toISOString();
  const ts = timestampId(input.now);
  const backupFileName = path.basename(input.backupFilePath);
  const tiers = deriveBackupTiers(input.now, input.previousManifest?.createdAt ?? null);
  const backupArtifacts: RecoveryBackupArtifact[] = [];

  for (const tier of tiers) {
    const upload = await input.writer.putObject({
      objectKey: `db/${tier}/${backupFileName}`,
      body: input.backupBuffer,
      contentType: "application/gzip",
    });
    backupArtifacts.push({
      tier,
      objectKey: upload.objectKey,
      sizeBytes: upload.sizeBytes,
      sha256: input.backupSha256,
      uploadedAt: upload.uploadedAt,
    });
  }

  const keySnapshot = input.keySnapshotBuffer && input.keySnapshotFingerprint
    ? await input.writer.putObject({
        objectKey: `keys/${input.keySnapshotFingerprint}/${ts}.json`,
        body: input.keySnapshotBuffer,
        contentType: "application/json",
      }).then((upload) => ({
        objectKey: upload.objectKey,
        sizeBytes: upload.sizeBytes,
        sha256: upload.sha256,
        uploadedAt: upload.uploadedAt,
        fingerprint: input.keySnapshotFingerprint as string,
        encrypted: true,
      }))
    : null;

  const configSnapshot = await input.writer.putObject({
    objectKey: `manifests/config/${ts}-${manifestId}.json`,
    body: input.configSnapshotBuffer,
    contentType: "application/json",
  });

  const manifestObjectKey = `manifests/${ts}-${manifestId}.json`;
  const manifest: RecoveryManifestRecord = {
    manifestId,
    createdAt,
    manifestObjectKey,
    sourceBackupFile: input.backupFilePath,
    sourceBackupCreatedAt: input.backupCreatedAt,
    storageProvider: input.storageProvider,
    assetCutoverComplete: input.assetCutoverComplete,
    assetSampleKeys: input.assetSampleKeys,
    backupArtifacts,
    keySnapshot,
    configSnapshot,
    warnings: input.warnings,
  };

  await input.writer.putObject({
    objectKey: manifestObjectKey,
    body: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"),
    contentType: "application/json",
  });

  return manifest;
}

function assertVaultBoundary(config: PaperclipConfig, vault: RecoveryVaultSummary | null): void {
  if (!vault) {
    throw new Error("Recovery vault is not configured. Set PAPERCLIP_RECOVERY_VAULT_BUCKET and PAPERCLIP_RECOVERY_VAULT_REGION.");
  }

  if (
    config.storage.s3.bucket.trim() &&
    config.storage.s3.bucket.trim() === vault.bucket &&
    normalizePrefix(config.storage.s3.prefix) === normalizePrefix(vault.prefix)
  ) {
    throw new Error("Recovery vault bucket/prefix must not match the live storage bucket/prefix.");
  }
}

export async function publishRecoveryManifest(opts: {
  configPath?: string;
  statusPath?: string;
  backupFile?: string;
  now?: Date;
}): Promise<PublishRecoveryResult> {
  const config = readConfigOrThrow(opts.configPath);
  const vaultConfig = createS3ConfigFromEnv(process.env);
  const vaultSummary = loadRecoveryVaultSummaryFromEnv(process.env);
  assertVaultBoundary(config, vaultSummary);

  const statusPath = opts.statusPath ?? resolveRecoveryStatusFilePath();
  const currentStatus = await readRecoveryStatusFile(statusPath);
  const connectionString = resolveConnectionString(opts.configPath);
  const now = opts.now ?? new Date();
  const backupFile = opts.backupFile
    ? path.resolve(opts.backupFile)
    : (await findLatestBackupFile(config)).filePath;
  const backupStat = await fsp.stat(backupFile);
  const backupBuffer = await fsp.readFile(backupFile);
  const keyPath = resolveMasterKeyPath(config);
  const keyPlaintext = await fsp.readFile(keyPath, "utf8");
  const encryptionSecret = process.env.PAPERCLIP_RECOVERY_KEY_ENCRYPTION_SECRET?.trim();
  if (!encryptionSecret) {
    throw new Error("PAPERCLIP_RECOVERY_KEY_ENCRYPTION_SECRET is required to publish encrypted key snapshots.");
  }
  const keySnapshotBuffer = encryptRecoveryKeySnapshot(encryptionSecret, Buffer.from(keyPlaintext, "utf8"));
  const keySnapshotFingerprint = sha256(Buffer.from(keyPlaintext, "utf8"));
  const configSnapshotBuffer = buildSanitizedConfigSnapshot(config);
  const assetProof = await getRecoveryAssetProofSnapshot(connectionString);
  const manifestAssetProof = deriveRecoveryManifestAssetProof({
    storageProvider: config.storage.provider,
    remainingLocalAssetCount: assetProof.remainingLocalAssetCount,
    sampleObjectKeys: assetProof.sampleObjectKeys,
  });
  const statusBefore = evaluateRecoveryStatus({
    ...currentStatus,
    backupIntervalMinutes: config.database.backup.intervalMinutes,
    storageProvider: config.storage.provider,
    vault: vaultSummary,
    assetCutover: {
      ...currentStatus.assetCutover,
      remainingLocalAssetCount: assetProof.remainingLocalAssetCount,
      sampleObjectKeys: assetProof.sampleObjectKeys,
    },
  }, now);
  const writer = buildRecoveryWriter(vaultConfig!);
  const manifest = await publishRecoveryArtifacts({
    writer,
    now,
    previousManifest: currentStatus.latestUploadedManifest,
    backupFilePath: backupFile,
    backupBuffer,
    backupSha256: sha256(backupBuffer),
    backupCreatedAt: backupStat.mtime.toISOString(),
    storageProvider: config.storage.provider,
    assetCutoverComplete: manifestAssetProof.assetCutoverComplete,
    assetSampleKeys: manifestAssetProof.assetSampleKeys,
    keySnapshotBuffer,
    keySnapshotFingerprint,
    configSnapshotBuffer,
    warnings: statusBefore.warnings,
  });

  const nextStatus: RecoveryStatusFile = {
    ...currentStatus,
    version: RECOVERY_STATUS_FILE_VERSION,
    updatedAt: now.toISOString(),
    backupIntervalMinutes: config.database.backup.intervalMinutes,
    storageProvider: config.storage.provider,
    vault: vaultSummary,
    latestUploadedManifest: manifest,
    warnings: statusBefore.warnings,
  };
  await writeRecoveryStatusFile(nextStatus, statusPath);

  return {
    status: evaluateRecoveryStatus(nextStatus, now),
    manifest,
    statusPath,
  };
}

function resolveLocalAssetPath(baseDir: string, objectKey: string): string {
  const normalized = objectKey.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error(`Invalid asset object key: ${objectKey}`);
  }
  return path.resolve(baseDir, normalized);
}

function withDb<T>(connectionString: string, action: (db: Db) => Promise<T>): Promise<T> {
  const db = createDb(connectionString);
  return action(db);
}

export async function migrateAssetsToS3(opts: {
  configPath?: string;
  statusPath?: string;
  switchProvider?: boolean;
}): Promise<AssetCutoverResult> {
  const config = readConfigOrThrow(opts.configPath);
  const statusPath = opts.statusPath ?? resolveRecoveryStatusFilePath();
  const currentStatus = await readRecoveryStatusFile(statusPath);
  const connectionString = resolveConnectionString(opts.configPath);
  const localBaseDir = path.resolve(expandHomePrefix(config.storage.localDisk.baseDir));
  const targetConfig: RecoveryS3Config = {
    bucket: config.storage.s3.bucket,
    region: config.storage.s3.region,
    endpoint: config.storage.s3.endpoint ?? null,
    prefix: normalizePrefix(config.storage.s3.prefix),
    forcePathStyle: config.storage.s3.forcePathStyle ?? false,
  };

  if (!targetConfig.bucket.trim() || !targetConfig.region.trim()) {
    throw new Error("Storage S3 bucket and region must be configured before asset cutover.");
  }

  const client = createS3Client(targetConfig);
  let migratedAssets = 0;
  let migratedBytes = 0;
  let skippedAssets = 0;
  let remainingLocalAssetCount = 0;
  let sampleObjectKeys: string[] = [];
  let switchApplied = false;
  const localAssets = await listLocalDiskAssets(connectionString);
  const migratedAssetIds = new Set<string>();
  const runStartedAt = new Date();

  try {
    for (const asset of localAssets) {
      const existing = await headS3Object(client, targetConfig, asset.objectKey);
      if (existing.exists && existing.contentLength === asset.byteSize) {
        const remoteBody = await getS3ObjectBuffer(client, targetConfig, asset.objectKey);
        if (canSkipRemoteAssetUpload({
          remoteBody,
          expectedSha256: asset.sha256,
          expectedByteSize: asset.byteSize,
        })) {
          skippedAssets += 1;
          migratedAssets += 1;
          migratedBytes += asset.byteSize;
          migratedAssetIds.add(asset.id);
          if (sampleObjectKeys.length < RECOVERY_ASSET_SAMPLE_LIMIT) {
            sampleObjectKeys.push(asset.objectKey);
          }
          continue;
        }
      }

      const sourcePath = resolveLocalAssetPath(localBaseDir, asset.objectKey);
      const body = await fsp.readFile(sourcePath);
      if (sha256(body) !== asset.sha256) {
        throw new Error(`Asset checksum mismatch for ${asset.objectKey}; aborting cutover.`);
      }
      await putS3Object(client, targetConfig, asset.objectKey, body, asset.contentType);
      migratedAssets += 1;
      migratedBytes += asset.byteSize;
      migratedAssetIds.add(asset.id);
      if (sampleObjectKeys.length < RECOVERY_ASSET_SAMPLE_LIMIT) {
        sampleObjectKeys.push(asset.objectKey);
      }
    }

    const currentLocalAssets = await listLocalDiskAssets(connectionString);
    const concurrentLocalAssetIds = detectConcurrentLocalAssetIds(migratedAssetIds, currentLocalAssets);
    remainingLocalAssetCount = concurrentLocalAssetIds.length;

    if (opts.switchProvider) {
      if (concurrentLocalAssetIds.length > 0) {
        throw new Error(
          `Asset cutover detected ${concurrentLocalAssetIds.length} concurrent local asset upload(s) during migration. Rerun with asset writes quiesced before switching storage.provider to s3.`,
        );
      }

      const migratedIds = [...migratedAssetIds];
      if (migratedIds.length > 0) {
        await withDb(connectionString, async (db) => {
          for (const batch of chunkArray(migratedIds, RECOVERY_ASSET_PROVIDER_UPDATE_BATCH_SIZE)) {
            await db
              .update(assets)
              .set({ provider: "s3" })
              .where(inArray(assets.id, batch));
          }
        });
      }
      writeConfig({
        ...config,
        storage: {
          ...config.storage,
          provider: "s3",
        },
      }, opts.configPath);
      switchApplied = true;
    }

    const nextAssetCutover: RecoveryAssetCutoverStatus = {
      lastRunAt: runStartedAt.toISOString(),
      switchedAt: switchApplied ? new Date().toISOString() : currentStatus.assetCutover.switchedAt,
      migratedAssetCount: migratedAssets,
      migratedByteCount: migratedBytes,
      remainingLocalAssetCount,
      sampleObjectKeys,
      lastError: null,
    };

    const nextConfig = readConfigOrThrow(opts.configPath);
    const nextStatus: RecoveryStatusFile = {
      ...currentStatus,
      version: RECOVERY_STATUS_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      backupIntervalMinutes: nextConfig.database.backup.intervalMinutes,
      storageProvider: nextConfig.storage.provider,
      vault: loadRecoveryVaultSummaryFromEnv(process.env),
      assetCutover: nextAssetCutover,
    };
    await writeRecoveryStatusFile(nextStatus, statusPath);

    return {
      status: evaluateRecoveryStatus(nextStatus),
      statusPath,
      migratedAssets,
      migratedBytes,
      skippedAssets,
      switchedProvider: switchApplied,
    };
  } catch (error) {
    remainingLocalAssetCount = await countCurrentLocalDiskAssets(connectionString);
    const failedConfig = readConfigOrThrow(opts.configPath);
    const failedStatus: RecoveryStatusFile = {
      ...currentStatus,
      version: RECOVERY_STATUS_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      backupIntervalMinutes: failedConfig.database.backup.intervalMinutes,
      storageProvider: failedConfig.storage.provider,
      vault: loadRecoveryVaultSummaryFromEnv(process.env),
      assetCutover: {
        lastRunAt: runStartedAt.toISOString(),
        switchedAt: currentStatus.assetCutover.switchedAt,
        migratedAssetCount: migratedAssets,
        migratedByteCount: migratedBytes,
        remainingLocalAssetCount,
        sampleObjectKeys,
        lastError: error instanceof Error ? error.message : String(error),
      },
    };
    await writeRecoveryStatusFile(failedStatus, statusPath);
    throw error;
  }
}

function createTempFilePath(prefix: string, extension: string): string {
  return path.resolve(process.cwd(), ".tmp", `${prefix}-${randomUUID()}${extension}`);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function readManifestFromVault(
  client: S3Client,
  config: RecoveryS3Config,
  objectKey: string,
): Promise<RecoveryManifestRecord> {
  const body = await getS3ObjectBuffer(client, config, objectKey);
  return JSON.parse(body.toString("utf8")) as RecoveryManifestRecord;
}

export async function runRecoveryDrill(opts: {
  configPath?: string;
  statusPath?: string;
  manifestObjectKey?: string;
  restoreConnectionString: string;
  restoreKeyFilePath?: string;
}): Promise<RecoveryDrillResult> {
  const config = readConfigOrThrow(opts.configPath);
  const statusPath = opts.statusPath ?? resolveRecoveryStatusFilePath();
  const currentStatus = await readRecoveryStatusFile(statusPath);
  const vaultConfig = createS3ConfigFromEnv(process.env);
  const vaultSummary = loadRecoveryVaultSummaryFromEnv(process.env);
  assertVaultBoundary(config, vaultSummary);

  const manifestKey = opts.manifestObjectKey ?? currentStatus.latestUploadedManifest?.manifestObjectKey;
  if (!manifestKey) {
    throw new Error("No recovery manifest is available to drill. Publish a manifest first or pass --manifest-key.");
  }

  const drillId = randomUUID();
  const startedAt = new Date();
  const failures: string[] = [];
  const verifiedChecks: string[] = [];
  let recoveredMasterKeyFileContents: Buffer | null = null;
  const client = createS3Client(vaultConfig!);
  const manifest = await readManifestFromVault(client, vaultConfig!, manifestKey);

  const backupArtifact = manifest.backupArtifacts.find((artifact) => artifact.tier === "hourly") ?? manifest.backupArtifacts[0];
  if (!backupArtifact) {
    throw new Error(`Recovery manifest ${manifest.manifestId} does not reference a DB backup artifact.`);
  }

  const tempBackupFile = createTempFilePath("paperclip-recovery-drill", ".sql.gz");
  const tempKeyFile = opts.restoreKeyFilePath
    ? path.resolve(opts.restoreKeyFilePath)
    : createTempFilePath("paperclip-recovery-key", ".key");

  try {
    await ensureParentDir(tempBackupFile);
    await ensureParentDir(tempKeyFile);
    await fsp.writeFile(
      tempBackupFile,
      await getS3ObjectBuffer(client, vaultConfig!, backupArtifact.objectKey),
    );
    await runDatabaseRestore({
      connectionString: opts.restoreConnectionString,
      backupFile: tempBackupFile,
    });
    verifiedChecks.push("database_restore");

    if (manifest.keySnapshot) {
      const encryptionSecret = process.env.PAPERCLIP_RECOVERY_KEY_ENCRYPTION_SECRET?.trim();
      if (!encryptionSecret) {
        failures.push("PAPERCLIP_RECOVERY_KEY_ENCRYPTION_SECRET is required to decrypt the recovery key snapshot.");
      } else {
        const keyPayload = await getS3ObjectBuffer(client, vaultConfig!, manifest.keySnapshot.objectKey);
        const keyBuffer = decryptRecoveryKeySnapshot(encryptionSecret, keyPayload);
        recoveredMasterKeyFileContents = keyBuffer;
        await fsp.writeFile(tempKeyFile, keyBuffer, { mode: 0o600 });
        verifiedChecks.push("secrets_key_snapshot");
      }
    } else {
      failures.push("Manifest does not contain a key snapshot.");
    }

    failures.push(...getRecoveryDrillAssetProofFailures(manifest));

    const sql = postgres(opts.restoreConnectionString, { max: 1, onnotice: () => {} });
    try {
      const restoredCompanies = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM public.companies
      `;
      if ((restoredCompanies[0]?.count ?? 0) <= 0) {
        failures.push("Restored database does not contain any companies.");
      } else {
        verifiedChecks.push("companies_present");
      }

      const restoredIssues = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM public.issues
      `;
      if ((restoredIssues[0]?.count ?? 0) >= 0) {
        verifiedChecks.push("issues_query");
      }

      const restoredSecrets = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM public.company_secrets
      `;
      if ((restoredSecrets[0]?.count ?? 0) >= 0) {
        verifiedChecks.push("secrets_query");
      }

      if (!recoveredMasterKeyFileContents) {
        failures.push("Recovered secrets master key is unavailable for restored secret verification.");
      } else {
        const restoredSecretSamples = await sql<Array<{
          companyId: string;
          secretId: string;
          name: string;
          version: number;
          material: Record<string, unknown>;
          valueSha256: string;
        }>>`
          SELECT
            cs.company_id AS "companyId",
            cs.id AS "secretId",
            cs.name AS "name",
            csv.version AS "version",
            csv.material AS "material",
            csv.value_sha256 AS "valueSha256"
          FROM public.company_secrets cs
          INNER JOIN public.company_secret_versions csv
            ON csv.secret_id = cs.id
          WHERE cs.provider = 'local_encrypted'
          ORDER BY csv.created_at DESC
          LIMIT 1
        `;

        const restoredSecretSample = restoredSecretSamples[0];
        if (!restoredSecretSample) {
          failures.push("Restored database does not contain any local_encrypted secret versions to validate.");
        } else {
          try {
            verifyRecoveredLocalEncryptedSecretValue({
              masterKeyFileContents: recoveredMasterKeyFileContents,
              material: restoredSecretSample.material,
              valueSha256: restoredSecretSample.valueSha256,
            });
            verifiedChecks.push("secrets_material_restore");
          } catch (error) {
            failures.push(
              `Recovered secrets master key could not decrypt restored secret material: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } finally {
      await sql.end();
    }

    const assetCheckConfig = createRecoveryAssetCheckConfig(config, process.env);
    const assetSampleKeys = manifest.assetSampleKeys.slice(0, RECOVERY_ASSET_SAMPLE_LIMIT);
    if (assetCheckConfig && assetSampleKeys.length > 0) {
      const assetClient = createS3Client(assetCheckConfig);
      for (const objectKey of assetSampleKeys) {
        const head = await headS3Object(assetClient, assetCheckConfig, objectKey);
        if (!head.exists) {
          failures.push(`Recovery asset sample is missing: ${objectKey}`);
        }
      }
      if (!failures.some((failure) => failure.startsWith("Recovery asset sample is missing"))) {
        verifiedChecks.push("asset_samples_present");
      }
    } else if (manifest.assetSampleKeys.length > 0) {
      failures.push("Asset sample verification is unavailable because no S3 asset verification target is configured.");
    }

    const finishedAt = new Date();
    const drill: RecoveryDrillRecord = {
      drillId,
      manifestId: manifest.manifestId,
      status: failures.length === 0 ? "passed" : "failed",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      verifiedChecks,
      failures,
      evidenceObjectKey: null,
    };

    const evidenceObjectKey = `drills/${timestampId(finishedAt)}-${drillId}.json`;
    const evidenceUpload = await putS3Object(
      client,
      vaultConfig!,
      evidenceObjectKey,
      Buffer.from(JSON.stringify({ manifest, drill }, null, 2) + "\n", "utf8"),
      "application/json",
    );
    drill.evidenceObjectKey = evidenceUpload.objectKey;

    const nextStatus: RecoveryStatusFile = {
      ...currentStatus,
      version: RECOVERY_STATUS_FILE_VERSION,
      updatedAt: finishedAt.toISOString(),
      backupIntervalMinutes: config.database.backup.intervalMinutes,
      storageProvider: config.storage.provider,
      vault: vaultSummary,
      latestDrillAttempt: drill,
      latestVerifiedRestore: drill.status === "passed" ? drill : currentStatus.latestVerifiedRestore,
    };
    await writeRecoveryStatusFile(nextStatus, statusPath);

    return {
      status: evaluateRecoveryStatus(nextStatus, finishedAt),
      drill,
      statusPath,
    };
  } finally {
    if (!opts.restoreKeyFilePath && fs.existsSync(tempKeyFile)) {
      await fsp.rm(tempKeyFile, { force: true });
    }
    if (fs.existsSync(tempBackupFile)) {
      await fsp.rm(tempBackupFile, { force: true });
    }
  }
}
