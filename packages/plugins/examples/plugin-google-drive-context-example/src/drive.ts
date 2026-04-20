import type { PluginContext } from "@paperclipai/plugin-sdk";

export const GOOGLE_DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";

export const STATE_NAMESPACE = "google-drive-context";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type DriveTargetKindHint = "folder" | "file" | null;

export interface DriveTargetConfig {
  companyId: string;
  projectId: string;
  urlOrId: string;
  title?: string;
}

export interface ParsedDriveTarget {
  id: string;
  kindHint: DriveTargetKindHint;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface DriveSyncCounts {
  imported: number;
  unsupported: number;
  failed: number;
  total: number;
}

export interface GoogleRefreshCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token_uri?: string;
}

export type GoogleCredential =
  | { kind: "access_token"; accessToken: string }
  | { kind: "refresh_token"; credentials: GoogleRefreshCredentials };

type HttpHost = Pick<PluginContext, "http">;
type SecretHost = Pick<PluginContext, "http" | "secrets">;
type DriveSyncHost = Pick<PluginContext, "config" | "http" | "secrets" | "state" | "contextSources" | "activity" | "logger">;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asPositiveInteger(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function parseTargetArray(value: unknown): DriveTargetConfig[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const companyId = asString(record.companyId);
    const projectId = asString(record.projectId);
    const urlOrId = asString(record.urlOrId);
    if (!companyId || !projectId || !urlOrId) return [];
    return [{
      companyId,
      projectId,
      urlOrId,
      title: asString(record.title) ?? undefined,
    }];
  });
}

function parseLegacyFolders(value: unknown): DriveTargetConfig[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const companyId = asString(record.companyId);
    const projectId = asString(record.projectId);
    const folderId = asString(record.folderId);
    if (!companyId || !projectId || !folderId) return [];
    return [{
      companyId,
      projectId,
      urlOrId: folderId,
      title: asString(record.title) ?? undefined,
    }];
  });
}

export function parseConfiguredTargets(config: Record<string, unknown>): DriveTargetConfig[] {
  const targets = [...parseTargetArray(config.targets), ...parseLegacyFolders(config.folders)];
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.companyId}:${target.projectId}:${target.urlOrId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getGoogleCredentialSecretRef(config: Record<string, unknown>) {
  return asString(config.googleCredentialSecretRef) ?? asString(config.accessTokenSecretRef);
}

export function parseDriveTarget(input: string): ParsedDriveTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Google Drive target is empty.");
  }

  try {
    const url = new URL(trimmed);
    const pathname = decodeURIComponent(url.pathname);
    const folderMatch = pathname.match(/\/folders\/([^/?#]+)/);
    if (folderMatch?.[1]) return { id: folderMatch[1], kindHint: "folder" };

    const fileMatch = pathname.match(/\/file\/d\/([^/?#]+)/);
    if (fileMatch?.[1]) return { id: fileMatch[1], kindHint: "file" };

    const docMatch = pathname.match(/\/document\/d\/([^/?#]+)/);
    if (docMatch?.[1]) return { id: docMatch[1], kindHint: "file" };

    const sheetMatch = pathname.match(/\/spreadsheets\/d\/([^/?#]+)/);
    if (sheetMatch?.[1]) return { id: sheetMatch[1], kindHint: "file" };

    const slidesMatch = pathname.match(/\/presentation\/d\/([^/?#]+)/);
    if (slidesMatch?.[1]) return { id: slidesMatch[1], kindHint: "file" };

    const idParam = url.searchParams.get("id");
    if (idParam?.trim()) return { id: idParam.trim(), kindHint: null };
  } catch {
    // Treat non-URL values as raw Drive IDs.
  }

  return { id: trimmed, kindHint: null };
}

function driveQueryFolder(folderId: string) {
  return `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`;
}

async function driveFetch(ctx: HttpHost, token: string, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await ctx.http.fetch(url, { ...init, headers });
  if (!response.ok) {
    throw new Error(`Google Drive request failed: ${response.status} ${response.statusText}`);
  }
  return response;
}

export async function fetchDriveFileMetadata(ctx: HttpHost, token: string, fileId: string): Promise<DriveFile> {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,modifiedTime,webViewLink",
    supportsAllDrives: "true",
  });
  const response = await driveFetch(
    ctx,
    token,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
  );
  const payload = await response.json() as Partial<DriveFile>;
  if (!payload.id || !payload.name || !payload.mimeType) {
    throw new Error("Google Drive file metadata response was missing required fields.");
  }
  return {
    id: payload.id,
    name: payload.name,
    mimeType: payload.mimeType,
    modifiedTime: payload.modifiedTime,
    webViewLink: payload.webViewLink,
  };
}

async function listDriveFolder(
  ctx: HttpHost,
  token: string,
  folderId: string,
  maxFiles: number,
  visitedFolders = new Set<string>(),
): Promise<DriveFile[]> {
  if (visitedFolders.has(folderId)) return [];
  visitedFolders.add(folderId);

  const out: DriveFile[] = [];
  let pageToken: string | null = null;
  while (out.length < maxFiles) {
    const params = new URLSearchParams({
      q: driveQueryFolder(folderId),
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)",
      pageSize: String(Math.min(100, maxFiles - out.length)),
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await driveFetch(ctx, token, `https://www.googleapis.com/drive/v3/files?${params.toString()}`);
    const payload = await response.json() as { files?: DriveFile[]; nextPageToken?: string };
    for (const file of payload.files ?? []) {
      if (file.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
        const nested = await listDriveFolder(ctx, token, file.id, maxFiles - out.length, visitedFolders);
        out.push(...nested);
      } else {
        out.push(file);
      }
      if (out.length >= maxFiles) break;
    }
    pageToken = payload.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return out.slice(0, maxFiles);
}

function exportMimeType(file: DriveFile): string | null {
  if (file.mimeType === GOOGLE_DOC_MIME) return "text/plain";
  if (file.mimeType === GOOGLE_SHEET_MIME) return "text/csv";
  if (file.mimeType === GOOGLE_SLIDES_MIME) return "text/plain";
  return null;
}

function isDirectTextMime(file: DriveFile) {
  return (
    file.mimeType.startsWith("text/") ||
    file.mimeType === "application/json" ||
    file.mimeType === "application/xml" ||
    file.mimeType === "application/javascript" ||
    file.mimeType === "application/typescript"
  );
}

async function readDriveFileText(ctx: HttpHost, token: string, file: DriveFile): Promise<string | null> {
  const exportType = exportMimeType(file);
  if (exportType) {
    const params = new URLSearchParams({ mimeType: exportType });
    const response = await driveFetch(
      ctx,
      token,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?${params.toString()}`,
    );
    return response.text();
  }
  if (isDirectTextMime(file)) {
    const response = await driveFetch(
      ctx,
      token,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
    );
    return response.text();
  }
  return null;
}

export function parseGoogleCredentialSecret(value: string): GoogleCredential {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Google credential secret is empty.");
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Google credential secret JSON is invalid.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Google credential secret JSON must be an object.");
    }
    const record = parsed as Record<string, unknown>;
    const clientId = asString(record.client_id);
    const clientSecret = asString(record.client_secret);
    const refreshToken = asString(record.refresh_token);
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("Google credential secret JSON must include client_id, client_secret, and refresh_token.");
    }
    return {
      kind: "refresh_token",
      credentials: {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        token_uri: asString(record.token_uri) ?? undefined,
      },
    };
  }

  return { kind: "access_token", accessToken: trimmed };
}

async function exchangeRefreshToken(ctx: HttpHost, credentials: GoogleRefreshCredentials) {
  const body = new URLSearchParams({
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    refresh_token: credentials.refresh_token,
    grant_type: "refresh_token",
  });
  const response = await ctx.http.fetch(credentials.token_uri ?? GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Google OAuth token refresh failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as { access_token?: unknown; error?: unknown; error_description?: unknown };
  const accessToken = asString(payload.access_token);
  if (!accessToken) {
    const detail = asString(payload.error_description) ?? asString(payload.error);
    throw new Error(detail ? `Google OAuth token refresh returned no access token: ${detail}` : "Google OAuth token refresh returned no access token.");
  }
  return accessToken;
}

export async function resolveGoogleAccessToken(ctx: SecretHost, secretRef: string) {
  const secretValue = await ctx.secrets.resolve(secretRef);
  const credential = parseGoogleCredentialSecret(secretValue);
  if (credential.kind === "access_token") return credential.accessToken;
  return exchangeRefreshToken(ctx, credential.credentials);
}

async function ensureContextSource(ctx: DriveSyncHost, target: DriveTargetConfig, metadata: DriveFile) {
  const targetType = metadata.mimeType === GOOGLE_DRIVE_FOLDER_MIME ? "folder" : "file";
  const stateKey = `source:${target.companyId}:${target.projectId}:${metadata.id}`;
  const stateScope = {
    scopeKind: "project" as const,
    scopeId: target.projectId,
    namespace: STATE_NAMESPACE,
    stateKey,
  };
  const existing = await ctx.state.get(stateScope);
  if (typeof existing === "string" && existing.trim()) {
    try {
      return await ctx.contextSources.setStatus(existing, target.companyId, "syncing");
    } catch (error) {
      ctx.logger.warn("Stored Drive context source was not reusable", {
        sourceId: existing,
        projectId: target.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const source = await ctx.contextSources.create({
    companyId: target.companyId,
    projectId: target.projectId,
    sourceType: "google_drive",
    provider: "google_drive",
    title: target.title ?? metadata.name ?? (targetType === "folder" ? "Google Drive folder" : "Google Drive file"),
    uri: metadata.webViewLink ?? target.urlOrId,
    externalId: metadata.id,
    metadata: {
      driveTargetId: metadata.id,
      driveTargetType: targetType,
      mimeType: metadata.mimeType,
    },
  });
  await ctx.state.set(stateScope, source.id);
  return source;
}

function buildStatusMessage(counts: DriveSyncCounts) {
  if (counts.failed > 0) {
    return `Imported ${counts.imported} Drive file(s), skipped ${counts.unsupported} unsupported file(s), and failed ${counts.failed} file(s).`;
  }
  if (counts.unsupported > 0) {
    return `Imported ${counts.imported} Drive file(s); skipped ${counts.unsupported} unsupported file(s).`;
  }
  if (counts.total === 0 || counts.imported === 0) {
    return "No text-indexable Drive files were found.";
  }
  return null;
}

export async function syncDriveTarget(
  ctx: DriveSyncHost,
  target: DriveTargetConfig,
  token: string,
  maxFiles: number,
): Promise<DriveSyncCounts> {
  const parsedTarget = parseDriveTarget(target.urlOrId);
  const metadata = await fetchDriveFileMetadata(ctx, token, parsedTarget.id);
  const source = await ensureContextSource(ctx, target, metadata);
  const files =
    metadata.mimeType === GOOGLE_DRIVE_FOLDER_MIME
      ? await listDriveFolder(ctx, token, metadata.id, maxFiles)
      : [metadata];
  const counts: DriveSyncCounts = { imported: 0, unsupported: 0, failed: 0, total: files.length };

  for (const file of files) {
    try {
      const bodyText = await readDriveFileText(ctx, token, file);
      if (bodyText) counts.imported += 1;
      else counts.unsupported += 1;
      await ctx.contextSources.upsertItem({
        companyId: target.companyId,
        sourceId: source.id,
        externalId: file.id,
        title: file.name,
        uri: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
        mimeType: file.mimeType,
        bodyText,
        status: bodyText ? "ready" : "unsupported",
        statusMessage: bodyText ? null : "Google Drive file type is not text-indexable yet.",
        sourceModifiedAt: file.modifiedTime ?? null,
        metadata: {
          driveFileId: file.id,
          mimeType: file.mimeType,
        },
      });
    } catch (error) {
      counts.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await ctx.contextSources.upsertItem({
        companyId: target.companyId,
        sourceId: source.id,
        externalId: file.id,
        title: file.name,
        uri: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
        mimeType: file.mimeType,
        bodyText: null,
        status: "error",
        statusMessage: `Failed to import Google Drive file: ${message}`,
        sourceModifiedAt: file.modifiedTime ?? null,
        metadata: {
          driveFileId: file.id,
          mimeType: file.mimeType,
        },
      });
    }
  }

  await ctx.contextSources.setStatus(
    source.id,
    target.companyId,
    counts.failed > 0 ? "error" : "ready",
    buildStatusMessage(counts),
  );
  await ctx.activity.log({
    companyId: target.companyId,
    message: "project.context_google_drive_synced",
    entityType: "context_source",
    entityId: source.id,
    metadata: {
      projectId: target.projectId,
      driveTargetId: metadata.id,
      driveTargetType: metadata.mimeType === GOOGLE_DRIVE_FOLDER_MIME ? "folder" : "file",
      ...counts,
    },
  });

  return counts;
}

export function validateDriveContextConfig(config: Record<string, unknown>) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const secretRef = getGoogleCredentialSecretRef(config);
  const targets = parseConfiguredTargets(config);
  if (!secretRef) errors.push("Configure a Google credential secret ref.");
  if (targets.length === 0) errors.push("Add at least one Google Drive target.");
  for (const target of targets) {
    try {
      parseDriveTarget(target.urlOrId);
    } catch (error) {
      errors.push(`${target.title ?? target.urlOrId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (asString(config.accessTokenSecretRef) || Array.isArray(config.folders)) {
    warnings.push("Legacy accessTokenSecretRef/folders config is supported, but googleCredentialSecretRef/targets is preferred.");
  }
  return { ok: errors.length === 0, errors, warnings, targetCount: targets.length };
}

export async function syncConfiguredDriveTargets(ctx: DriveSyncHost) {
  const config = await ctx.config.get();
  const secretRef = getGoogleCredentialSecretRef(config);
  const targets = parseConfiguredTargets(config);
  const maxFiles = asPositiveInteger(config.maxFilesPerTarget ?? config.maxFilesPerFolder, 50);
  if (!secretRef || targets.length === 0) {
    ctx.logger.info("Google Drive context sync skipped; no credential secret ref or targets configured.");
    return;
  }

  const token = await resolveGoogleAccessToken(ctx, secretRef);
  const failures: string[] = [];
  for (const target of targets) {
    try {
      await syncDriveTarget(ctx, target, token, maxFiles);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${target.title ?? target.urlOrId}: ${message}`);
      ctx.logger.error("Google Drive target sync failed", {
        companyId: target.companyId,
        projectId: target.projectId,
        target: target.urlOrId,
        error: message,
      });
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} Google Drive target(s) failed to sync: ${failures.join("; ")}`);
  }
}
