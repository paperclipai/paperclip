import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { plugins, runDatabaseBackup } from "@paperclipai/db";
import {
  DEFAULT_INSTANCE_UPDATE_SETTINGS,
  type InstanceInstallContext,
  type InstancePreUpdateBackupManifest,
  type InstancePreUpdateBackupStatus,
  type InstancePreUpdateBackupSummary,
  type InstanceUpdateSettings,
  type InstanceUpdateStatus,
  type StorageProvider,
} from "@paperclipai/shared";
import { listAdapterPlugins } from "./adapter-plugin-store.js";
import { instanceSettingsService } from "./instance-settings.js";
import { unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);

export const UPDATE_CHECK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const PRE_UPDATE_BACKUP_VALID_MS = 24 * 60 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 3_500;
const GIT_TIMEOUT_MS = 2_500;
const MAX_CACHE_BYTES = 32 * 1024;

type LatestVersionCheck = {
  latestVersion: string | null;
  releaseUrl: string | null;
  checkedAt: string | null;
  source: "npm" | "github" | "cache" | null;
  error: string | null;
};

type CachedLatestVersionCheck = {
  latestVersion: string;
  releaseUrl: string | null;
  checkedAt: string;
  source: "npm" | "github";
};

export type InstanceUpdateSafetyOptions = {
  currentVersion: string;
  connectionString: string;
  backupDir: string;
  instanceRoot: string;
  configPath: string;
  envPath: string;
  secretsKeyFilePath: string;
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir?: string;
  storageS3Bucket?: string;
  storageS3Region?: string;
  storageS3Endpoint?: string;
  storageS3Prefix?: string;
  cwd?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function nowIso(opts: InstanceUpdateSafetyOptions): string {
  return (opts.now?.() ?? new Date()).toISOString();
}

function toDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function sanitizePathSegment(value: string | null | undefined, fallback = "unknown"): string {
  const trimmed = value?.trim() ?? "";
  const normalized = trimmed
    .replace(/^v/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

type ParsedVersion = {
  numbers: number[];
  prerelease: string[];
};

export function parseComparableVersion(value: string | null | undefined): ParsedVersion | null {
  const trimmed = value?.trim().replace(/^v/i, "") ?? "";
  if (!trimmed) return null;
  const [numericPart, prereleasePart] = trimmed.split("-", 2);
  const numberStrings = numericPart.split(".");
  if (numberStrings.length < 2) return null;
  const numbers = numberStrings.map((entry) => Number(entry));
  if (numbers.some((entry) => !Number.isInteger(entry) || entry < 0)) return null;
  while (numbers.length < 3) numbers.push(0);
  return {
    numbers,
    prerelease: prereleasePart ? prereleasePart.split(".").filter(Boolean) : [],
  };
}

export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const left = parseComparableVersion(a);
  const right = parseComparableVersion(b);
  if (!left || !right) return 0;
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.numbers[index] ?? 0;
    const r = right.numbers[index] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1;
  return left.prerelease.join(".").localeCompare(right.prerelease.join("."));
}

function isNewerVersion(candidate: string | null, current: string): boolean {
  if (!candidate) return false;
  return compareVersions(candidate, current) > 0;
}

async function execGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function detectInstallContext(
  currentVersion: string,
  cwd = process.cwd(),
): Promise<InstanceInstallContext> {
  const root = await execGit(["rev-parse", "--show-toplevel"], cwd);
  if (!root) {
    return {
      currentVersion,
      gitRepositoryRoot: null,
      gitBranch: null,
      gitSha: null,
      gitDirty: null,
    };
  }

  const [branch, sha, status] = await Promise.all([
    execGit(["rev-parse", "--abbrev-ref", "HEAD"], root),
    execGit(["rev-parse", "--short", "HEAD"], root),
    execGit(["status", "--porcelain"], root),
  ]);

  return {
    currentVersion,
    gitRepositoryRoot: root,
    gitBranch: branch || null,
    gitSha: sha || null,
    gitDirty: status === null ? null : status.length > 0,
  };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "paperclip-update-safety",
      },
    });
    if (!response.ok) {
      throw new Error(`Request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLatestStable(fetchImpl: typeof fetch): Promise<LatestVersionCheck> {
  const checkedAt = new Date().toISOString();
  try {
    const payload = await fetchJson(fetchImpl, "https://registry.npmjs.org/paperclipai/latest");
    const latestVersion = typeof payload.version === "string" ? payload.version.trim() : "";
    if (latestVersion) {
      return {
        latestVersion,
        releaseUrl: `https://github.com/paperclipai/paperclip/releases/tag/v${latestVersion}`,
        checkedAt,
        source: "npm",
        error: null,
      };
    }
    throw new Error("npm latest metadata did not include a version");
  } catch (npmError) {
    try {
      const payload = await fetchJson(fetchImpl, "https://api.github.com/repos/paperclipai/paperclip/releases/latest");
      const tagName = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
      const htmlUrl = typeof payload.html_url === "string" ? payload.html_url.trim() : "";
      const latestVersion = tagName.replace(/^v/i, "");
      if (latestVersion) {
        return {
          latestVersion,
          releaseUrl: htmlUrl || `https://github.com/paperclipai/paperclip/releases/tag/${tagName}`,
          checkedAt,
          source: "github",
          error: null,
        };
      }
      throw new Error("GitHub latest release metadata did not include a tag");
    } catch (githubError) {
      return {
        latestVersion: null,
        releaseUrl: null,
        checkedAt: null,
        source: null,
        error: `${getErrorMessage(npmError)}; GitHub fallback failed: ${getErrorMessage(githubError)}`,
      };
    }
  }
}

function resolveCachePath(opts: InstanceUpdateSafetyOptions): string {
  return path.resolve(opts.instanceRoot, "data", "update-status.json");
}

function resolvePreUpdateBackupDir(opts: InstanceUpdateSafetyOptions): string {
  return path.resolve(opts.backupDir, "pre-update");
}

async function readCachedLatest(cachePath: string): Promise<CachedLatestVersionCheck | null> {
  try {
    const fileStat = await stat(cachePath);
    if (!fileStat.isFile() || fileStat.size > MAX_CACHE_BYTES) return null;
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, unknown>;
    const latestVersion = typeof parsed.latestVersion === "string" ? parsed.latestVersion.trim() : "";
    const checkedAt = typeof parsed.checkedAt === "string" ? parsed.checkedAt.trim() : "";
    const source = parsed.source === "github" ? "github" : "npm";
    if (!latestVersion || !checkedAt) return null;
    return {
      latestVersion,
      checkedAt,
      source,
      releaseUrl: typeof parsed.releaseUrl === "string" && parsed.releaseUrl.trim()
        ? parsed.releaseUrl.trim()
        : null,
    };
  } catch {
    return null;
  }
}

async function writeCachedLatest(cachePath: string, check: LatestVersionCheck): Promise<void> {
  if (!check.latestVersion || !check.checkedAt || !check.source || check.source === "cache") return;
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify({
      latestVersion: check.latestVersion,
      releaseUrl: check.releaseUrl,
      checkedAt: check.checkedAt,
      source: check.source,
    }, null, 2) + "\n",
    "utf8",
  );
}

async function getLatestVersionCheck(
  opts: InstanceUpdateSafetyOptions,
  settings: InstanceUpdateSettings,
  force = false,
): Promise<LatestVersionCheck> {
  if (!settings.updateChecksEnabled) {
    return {
      latestVersion: null,
      releaseUrl: null,
      checkedAt: null,
      source: null,
      error: null,
    };
  }

  const cachePath = resolveCachePath(opts);
  const cached = await readCachedLatest(cachePath);
  const cachedAtMs = toDateMs(cached?.checkedAt);
  const nowMs = (opts.now?.() ?? new Date()).getTime();
  if (!force && cached && cachedAtMs !== null && nowMs - cachedAtMs < UPDATE_CHECK_CACHE_TTL_MS) {
    return {
      latestVersion: cached.latestVersion,
      releaseUrl: cached.releaseUrl,
      checkedAt: cached.checkedAt,
      source: "cache",
      error: null,
    };
  }

  const check = await fetchLatestStable(opts.fetchImpl ?? fetch);
  if (check.latestVersion) {
    await writeCachedLatest(cachePath, check);
    return check;
  }

  if (cached) {
    return {
      latestVersion: cached.latestVersion,
      releaseUrl: cached.releaseUrl,
      checkedAt: cached.checkedAt,
      source: "cache",
      error: check.error,
    };
  }

  return check;
}

function summarizeManifest(manifest: InstancePreUpdateBackupManifest, manifestPath: string): InstancePreUpdateBackupSummary {
  return {
    id: manifest.id,
    status: manifest.status,
    createdAt: manifest.createdAt,
    currentVersion: manifest.currentVersion,
    targetVersion: manifest.targetVersion,
    backupDir: manifest.backupDir,
    manifestPath,
    databaseBackupFile: manifest.databaseBackupFile,
    externalStorageAcknowledged: manifest.externalStorageAcknowledged,
    storageProvider: manifest.storage.provider,
    warnings: manifest.warnings,
    error: manifest.error,
  };
}

async function readManifest(manifestPath: string): Promise<InstancePreUpdateBackupSummary | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as InstancePreUpdateBackupManifest;
    if (parsed?.version !== 1 || !parsed.id || !parsed.createdAt) return null;
    return summarizeManifest(parsed, manifestPath);
  } catch {
    return null;
  }
}

async function listPreUpdateBackupSummaries(opts: InstanceUpdateSafetyOptions): Promise<InstancePreUpdateBackupSummary[]> {
  const root = resolvePreUpdateBackupDir(opts);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readManifest(path.join(root, entry.name, "manifest.json"))),
    );
    return summaries
      .filter((entry): entry is InstancePreUpdateBackupSummary => entry !== null)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } catch {
    return [];
  }
}

function backupStatusFromLatest(
  latest: InstancePreUpdateBackupSummary | null,
  opts: InstanceUpdateSafetyOptions,
  targetVersion: string | null,
): InstancePreUpdateBackupStatus {
  const externalStorageRequiresAcknowledgement = opts.storageProvider !== "local_disk";
  const required = Boolean(targetVersion);
  if (!required) {
    return {
      required: false,
      valid: true,
      reason: "none",
      targetVersion,
      expiresAt: null,
      latest,
      externalStorageRequiresAcknowledgement,
    };
  }

  if (!latest) {
    return {
      required,
      valid: false,
      reason: "missing",
      targetVersion,
      expiresAt: null,
      latest,
      externalStorageRequiresAcknowledgement,
    };
  }

  if (latest.status !== "succeeded") {
    return {
      required,
      valid: false,
      reason: "failed",
      targetVersion,
      expiresAt: null,
      latest,
      externalStorageRequiresAcknowledgement,
    };
  }

  if (latest.targetVersion !== targetVersion) {
    return {
      required,
      valid: false,
      reason: "target_mismatch",
      targetVersion,
      expiresAt: null,
      latest,
      externalStorageRequiresAcknowledgement,
    };
  }

  const createdAtMs = toDateMs(latest.createdAt);
  const nowMs = (opts.now?.() ?? new Date()).getTime();
  const expiresAtMs = createdAtMs === null ? null : createdAtMs + PRE_UPDATE_BACKUP_VALID_MS;
  if (createdAtMs === null || expiresAtMs === null || nowMs > expiresAtMs) {
    return {
      required,
      valid: false,
      reason: "stale",
      targetVersion,
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      latest,
      externalStorageRequiresAcknowledgement,
    };
  }

  if (externalStorageRequiresAcknowledgement && !latest.externalStorageAcknowledged) {
    return {
      required,
      valid: false,
      reason: "external_storage_unverified",
      targetVersion,
      expiresAt: new Date(expiresAtMs).toISOString(),
      latest,
      externalStorageRequiresAcknowledgement,
    };
  }

  return {
    required,
    valid: true,
    reason: "none",
    targetVersion,
    expiresAt: new Date(expiresAtMs).toISOString(),
    latest,
    externalStorageRequiresAcknowledgement,
  };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function collectFileStats(
  root: string,
  relativeDir = "",
): Promise<{ checksums: Record<string, string>; fileCount: number; bytes: number }> {
  const checksums: Record<string, string> = {};
  let fileCount = 0;
  let bytes = 0;
  const dir = path.join(root, relativeDir);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (relativePath === "manifest.json") continue;
    const fullPath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      const nested = await collectFileStats(root, relativePath);
      Object.assign(checksums, nested.checksums);
      fileCount += nested.fileCount;
      bytes += nested.bytes;
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(fullPath);
    fileCount += 1;
    bytes += fileStat.size;
    checksums[relativePath.replaceAll(path.sep, "/")] = await hashFile(fullPath);
  }
  return { checksums, fileCount, bytes };
}

async function copyIfExists(source: string, destination: string): Promise<boolean> {
  if (!existsSync(source)) return false;
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true, errorOnExist: false });
  return true;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writeGitMetadata(root: string, install: InstanceInstallContext): Promise<boolean> {
  if (!install.gitRepositoryRoot) return false;
  await mkdir(path.join(root, "git"), { recursive: true });
  const gitRoot = install.gitRepositoryRoot;
  const [statusShort, diffStat, diffNameStatus, stagedNameStatus] = await Promise.all([
    execGit(["status", "--short"], gitRoot),
    execGit(["diff", "--stat"], gitRoot),
    execGit(["diff", "--name-status"], gitRoot),
    execGit(["diff", "--cached", "--name-status"], gitRoot),
  ]);
  await writeJsonFile(path.join(root, "git", "metadata.json"), install);
  await writeFile(path.join(root, "git", "status.txt"), statusShort ?? "", "utf8");
  await writeFile(path.join(root, "git", "diff-stat.txt"), diffStat ?? "", "utf8");
  await writeFile(path.join(root, "git", "diff-name-status.txt"), diffNameStatus ?? "", "utf8");
  await writeFile(path.join(root, "git", "staged-name-status.txt"), stagedNameStatus ?? "", "utf8");
  return true;
}

function createEmptyManifest(
  opts: InstanceUpdateSafetyOptions,
  backupRoot: string,
  targetVersion: string | null,
  install: InstanceInstallContext,
  externalStorageAcknowledged: boolean,
): InstancePreUpdateBackupManifest {
  return {
    version: 1,
    id: randomUUID(),
    status: "failed",
    createdAt: nowIso(opts),
    currentVersion: opts.currentVersion,
    targetVersion,
    backupDir: backupRoot,
    databaseBackupFile: null,
    externalStorageAcknowledged,
    storage: {
      provider: opts.storageProvider,
      localDiskPath: opts.storageProvider === "local_disk" ? opts.storageLocalDiskBaseDir ?? null : null,
      s3Bucket: opts.storageProvider === "s3" ? opts.storageS3Bucket ?? null : null,
      s3Region: opts.storageProvider === "s3" ? opts.storageS3Region ?? null : null,
      s3Endpoint: opts.storageProvider === "s3" ? opts.storageS3Endpoint ?? null : null,
      s3Prefix: opts.storageProvider === "s3" ? opts.storageS3Prefix ?? null : null,
    },
    install,
    included: {
      database: false,
      configFiles: false,
      localStorage: false,
      secretsKey: false,
      pluginInventory: false,
      externalAdapterInventory: false,
      gitMetadata: false,
    },
    counts: {
      pluginCount: 0,
      externalAdapterCount: 0,
      copiedFileCount: 0,
      copiedBytes: 0,
    },
    checksums: {},
    warnings: [],
    error: null,
  };
}

export function instanceUpdateSafetyService(db: Db, opts: InstanceUpdateSafetyOptions) {
  const settingsSvc = instanceSettingsService(db);

  async function getSettings(): Promise<InstanceUpdateSettings> {
    const general = await settingsSvc.getGeneral();
    return general.updateSettings ?? DEFAULT_INSTANCE_UPDATE_SETTINGS;
  }

  async function getPreUpdateBackupStatus(targetVersion: string | null): Promise<InstancePreUpdateBackupStatus> {
    const summaries = await listPreUpdateBackupSummaries(opts);
    const latest = summaries[0] ?? null;
    return backupStatusFromLatest(latest, opts, targetVersion);
  }

  async function getUpdateStatus(force = false): Promise<InstanceUpdateStatus> {
    const settings = await getSettings();
    const install = await detectInstallContext(opts.currentVersion, opts.cwd ?? process.cwd());
    const check = await getLatestVersionCheck(opts, settings, force);
    const updateAvailable = settings.updateChecksEnabled && isNewerVersion(check.latestVersion, opts.currentVersion);
    const backup = await getPreUpdateBackupStatus(updateAvailable ? check.latestVersion : null);
    const dismissed = Boolean(check.latestVersion && settings.dismissedVersion === check.latestVersion);
    const reasons: string[] = [];

    if (updateAvailable && !backup.valid) reasons.push("backup_required");
    if (updateAvailable && install.gitDirty) reasons.push("local_core_edits");
    if (updateAvailable && backup.externalStorageRequiresAcknowledgement && backup.reason === "external_storage_unverified") {
      reasons.push("external_storage_acknowledgement_required");
    }

    const status = !settings.updateChecksEnabled
      ? "disabled"
      : check.error && !check.latestVersion
        ? "offline"
        : updateAvailable
          ? "update_available"
          : check.latestVersion
            ? "up_to_date"
            : "unknown";

    const checkedAtMs = toDateMs(check.checkedAt);
    return {
      status,
      currentVersion: opts.currentVersion,
      latestVersion: check.latestVersion,
      updateAvailable,
      releaseUrl: check.releaseUrl,
      checkedAt: check.checkedAt,
      nextCheckAt: checkedAtMs === null ? null : new Date(checkedAtMs + UPDATE_CHECK_CACHE_TTL_MS).toISOString(),
      checkSource: check.source,
      error: check.error,
      settings,
      install,
      backup,
      banner: {
        shouldShow: updateAvailable && !dismissed,
        tone: updateAvailable ? (reasons.length > 0 ? "warn" : "info") : null,
        reasons,
      },
    };
  }

  async function dismissUpdate(version?: string | null): Promise<InstanceUpdateStatus> {
    const currentStatus = await getUpdateStatus(false);
    const dismissedVersion = version?.trim() || currentStatus.latestVersion;
    if (!dismissedVersion) return currentStatus;
    await settingsSvc.updateUpdateSettings({
      dismissedVersion,
      dismissedAt: nowIso(opts),
    });
    return getUpdateStatus(false);
  }

  async function createPreUpdateBackup(input: {
    targetVersion?: string | null;
    acknowledgeExternalStorage?: boolean;
  } = {}): Promise<InstancePreUpdateBackupSummary> {
    const targetVersion = input.targetVersion ?? null;
    const externalStorageAcknowledged = opts.storageProvider === "local_disk"
      ? false
      : input.acknowledgeExternalStorage === true;
    if (opts.storageProvider !== "local_disk" && !externalStorageAcknowledged) {
      throw unprocessable("External storage backup acknowledgement is required before creating a pre-update backup.");
    }

    const install = await detectInstallContext(opts.currentVersion, opts.cwd ?? process.cwd());
    const timestamp = nowIso(opts).replace(/[:.]/g, "-");
    const backupRoot = path.resolve(
      resolvePreUpdateBackupDir(opts),
      `${timestamp}-to-${sanitizePathSegment(targetVersion)}`,
    );
    await mkdir(backupRoot, { recursive: true });
    const manifestPath = path.join(backupRoot, "manifest.json");
    const manifest = createEmptyManifest(opts, backupRoot, targetVersion, install, externalStorageAcknowledged);

    try {
      const dbBackup = await runDatabaseBackup({
        connectionString: opts.connectionString,
        backupDir: path.join(backupRoot, "database"),
        retention: { dailyDays: 30, weeklyWeeks: 4, monthlyMonths: 3 },
        filenamePrefix: "paperclip-pre-update",
      });
      manifest.databaseBackupFile = dbBackup.backupFile;
      manifest.included.database = true;

      const copiedConfig = await copyIfExists(opts.configPath, path.join(backupRoot, "config", path.basename(opts.configPath)));
      const copiedEnv = await copyIfExists(opts.envPath, path.join(backupRoot, "config", path.basename(opts.envPath)));
      manifest.included.configFiles = copiedConfig || copiedEnv;
      if (!copiedConfig) manifest.warnings.push(`Config file not found: ${opts.configPath}`);
      if (!copiedEnv) manifest.warnings.push(`Env file not found: ${opts.envPath}`);

      const copiedSecrets = await copyIfExists(
        opts.secretsKeyFilePath,
        path.join(backupRoot, "secrets", path.basename(opts.secretsKeyFilePath)),
      );
      manifest.included.secretsKey = copiedSecrets;
      if (copiedSecrets) {
        manifest.warnings.push("Backup includes the local secrets master key. Protect this snapshot like production credentials.");
      } else {
        manifest.warnings.push(`Secrets key file not found: ${opts.secretsKeyFilePath}`);
      }

      if (opts.storageProvider === "local_disk") {
        if (opts.storageLocalDiskBaseDir && existsSync(opts.storageLocalDiskBaseDir)) {
          await copyIfExists(opts.storageLocalDiskBaseDir, path.join(backupRoot, "storage"));
          manifest.included.localStorage = true;
        } else {
          manifest.warnings.push("Local storage directory was not found, so uploaded assets were not copied.");
        }
      } else {
        manifest.warnings.push("S3 object storage was not copied. The acknowledgement records that the operator will back it up separately.");
      }

      const pluginRows = await db
        .select({
          id: plugins.id,
          pluginKey: plugins.pluginKey,
          packageName: plugins.packageName,
          version: plugins.version,
          status: plugins.status,
          packagePath: plugins.packagePath,
          updatedAt: plugins.updatedAt,
        })
        .from(plugins);
      manifest.counts.pluginCount = pluginRows.length;
      await writeJsonFile(path.join(backupRoot, "plugins", "installed-plugins.json"), pluginRows);
      manifest.included.pluginInventory = true;

      const adapterPlugins = listAdapterPlugins();
      manifest.counts.externalAdapterCount = adapterPlugins.length;
      await writeJsonFile(path.join(backupRoot, "plugins", "external-adapters.json"), adapterPlugins);
      manifest.included.externalAdapterInventory = true;

      manifest.included.gitMetadata = await writeGitMetadata(backupRoot, install);
      if (install.gitDirty) {
        manifest.warnings.push("Local source checkout has uncommitted changes. Updating core files may require manual merge work.");
      }

      const fileStats = await collectFileStats(backupRoot);
      manifest.checksums = fileStats.checksums;
      manifest.counts.copiedFileCount = fileStats.fileCount;
      manifest.counts.copiedBytes = fileStats.bytes;
      manifest.status = "succeeded";
      await writeJsonFile(manifestPath, manifest);
      return summarizeManifest(manifest, manifestPath);
    } catch (error) {
      manifest.status = "failed";
      manifest.error = getErrorMessage(error);
      await writeJsonFile(manifestPath, manifest);
      throw error;
    }
  }

  return {
    getUpdateStatus,
    checkNow: () => getUpdateStatus(true),
    dismissUpdate,
    getPreUpdateBackupStatus,
    createPreUpdateBackup,
  };
}
