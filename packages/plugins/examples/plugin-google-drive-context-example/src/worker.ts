import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";

const GOOGLE_DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
const STATE_NAMESPACE = "google-drive-context";

type DriveFolderConfig = {
  companyId: string;
  projectId: string;
  folderId: string;
  title?: string;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPositiveInteger(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function parseFolders(value: unknown): DriveFolderConfig[] {
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
      folderId,
      title: asString(record.title) ?? undefined,
    }];
  });
}

function extractFolderId(input: string) {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const folderMatch = url.pathname.match(/\/folders\/([^/?]+)/);
    if (folderMatch?.[1]) return decodeURIComponent(folderMatch[1]);
    const idParam = url.searchParams.get("id");
    if (idParam) return idParam;
  } catch {
    // Treat non-URL values as raw Drive IDs.
  }
  return trimmed;
}

function driveQueryFolder(folderId: string) {
  return `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`;
}

async function driveFetch(ctx: PluginContext, token: string, url: string) {
  const response = await ctx.http.fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Google Drive request failed: ${response.status} ${response.statusText}`);
  }
  return response;
}

async function listDriveFolder(
  ctx: PluginContext,
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

async function readDriveFileText(ctx: PluginContext, token: string, file: DriveFile): Promise<string | null> {
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

async function ensureContextSource(ctx: PluginContext, folder: DriveFolderConfig) {
  const folderId = extractFolderId(folder.folderId);
  const stateKey = `source:${folder.companyId}:${folder.projectId}:${folderId}`;
  const stateScope = {
    scopeKind: "project" as const,
    scopeId: folder.projectId,
    namespace: STATE_NAMESPACE,
    stateKey,
  };
  const existing = await ctx.state.get(stateScope);
  if (typeof existing === "string" && existing.trim()) {
    try {
      return await ctx.contextSources.setStatus(existing, folder.companyId, "syncing");
    } catch (error) {
      ctx.logger.warn("Stored Drive context source was not reusable", {
        sourceId: existing,
        projectId: folder.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const source = await ctx.contextSources.create({
    companyId: folder.companyId,
    projectId: folder.projectId,
    sourceType: "google_drive",
    provider: "google_drive",
    title: folder.title ?? "Google Drive folder",
    uri: folder.folderId,
    externalId: folderId,
    metadata: {
      driveFolderId: folderId,
    },
  });
  await ctx.state.set(stateScope, source.id);
  return source;
}

async function syncFolder(ctx: PluginContext, folder: DriveFolderConfig, token: string, maxFiles: number) {
  const folderId = extractFolderId(folder.folderId);
  const source = await ensureContextSource(ctx, folder);
  let imported = 0;
  let unsupported = 0;

  try {
    const files = await listDriveFolder(ctx, token, folderId, maxFiles);
    for (const file of files) {
      const bodyText = await readDriveFileText(ctx, token, file);
      if (bodyText) imported += 1;
      else unsupported += 1;
      await ctx.contextSources.upsertItem({
        companyId: folder.companyId,
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
    }
    await ctx.contextSources.setStatus(
      source.id,
      folder.companyId,
      "ready",
      unsupported > 0 ? `${unsupported} Drive files were skipped because they are not text-indexable yet.` : null,
    );
    await ctx.activity.log({
      companyId: folder.companyId,
      message: "project.context_google_drive_synced",
      entityType: "context_source",
      entityId: source.id,
      metadata: { projectId: folder.projectId, folderId, imported, unsupported },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.contextSources.setStatus(source.id, folder.companyId, "error", message);
    throw error;
  }
}

async function syncConfiguredFolders(ctx: PluginContext) {
  const config = await ctx.config.get();
  const secretRef = asString(config.accessTokenSecretRef);
  const folders = parseFolders(config.folders);
  const maxFiles = asPositiveInteger(config.maxFilesPerFolder, 50);
  if (!secretRef || folders.length === 0) {
    ctx.logger.info("Google Drive context sync skipped; no token secret ref or folders configured.");
    return;
  }
  const token = await ctx.secrets.resolve(secretRef);
  for (const folder of folders) {
    await syncFolder(ctx, folder, token, maxFiles);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("sync-drive-folders", async () => {
      await syncConfiguredFolders(ctx);
    });
    ctx.logger.info("Google Drive context example plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Google Drive context example plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
