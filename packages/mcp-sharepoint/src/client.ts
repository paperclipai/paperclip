import type { SharepointMcpConfig } from "./config.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export interface ExcelWorksheet {
  id: string;
  name: string;
  position: number;
  visibility: string;
}

export interface ExcelRange {
  address: string;
  values: unknown[][];
  text: string[][];
  rowCount: number;
  columnCount: number;
}

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: { mimeType: string };
  folder?: { childCount: number };
  parentReference?: { path: string };
}

export interface Drive {
  id: string;
  name: string;
  driveType: string;
  webUrl?: string;
}

export class SharepointApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    const msg = typeof body === "object" && body !== null
      ? ((body as Record<string, unknown>)?.error as Record<string, unknown>)?.message as string
      : String(body);
    super(`SharePoint API ${method} ${url} → ${status}: ${msg ?? "unknown error"}`);
    this.name = "SharepointApiError";
  }
}

export class SharepointClient {
  private tokenCache: TokenCache | null = null;
  private siteId: string | null = null;

  constructor(private readonly config: SharepointMcpConfig) {}

  // ── Auth ────────────────────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.accessToken;
    }

    const url = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token fetch failed ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return this.tokenCache.accessToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let errBody: unknown;
      try { errBody = await res.json(); } catch { errBody = await res.text(); }
      throw new SharepointApiError(res.status, method, url, errBody);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async requestRaw(method: string, path: string, body?: string): Promise<Response> {
    const token = await this.getAccessToken();
    const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": body !== undefined ? "application/octet-stream" : "application/json",
      },
      body,
    });
  }

  // ── Site resolution ──────────────────────────────────────────────────────────

  private parseSiteHostAndPath(): { host: string; sitePath: string } {
    const url = new URL(this.config.siteUrl);
    return { host: url.hostname, sitePath: url.pathname };
  }

  async getSiteId(): Promise<string> {
    if (this.siteId) return this.siteId;
    const { host, sitePath } = this.parseSiteHostAndPath();
    const data = await this.request<{ id: string }>("GET", `/sites/${host}:${sitePath}`);
    this.siteId = data.id;
    return this.siteId;
  }

  // ── Drives ──────────────────────────────────────────────────────────────────

  async listDrives(): Promise<Drive[]> {
    const siteId = await this.getSiteId();
    const data = await this.request<{ value: Drive[] }>("GET", `/sites/${siteId}/drives`);
    return data.value;
  }

  async getDefaultDriveId(): Promise<string> {
    const siteId = await this.getSiteId();
    const data = await this.request<{ id: string }>("GET", `/sites/${siteId}/drive`);
    return data.id;
  }

  // ── File listing ─────────────────────────────────────────────────────────────

  async listRootFiles(driveId?: string): Promise<DriveItem[]> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const data = await this.request<{ value: DriveItem[] }>(
      "GET",
      `/sites/${siteId}/drives/${dId}/root/children`,
    );
    return data.value;
  }

  async listFolderChildren(itemId: string, driveId?: string): Promise<DriveItem[]> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const data = await this.request<{ value: DriveItem[] }>(
      "GET",
      `/sites/${siteId}/drives/${dId}/items/${itemId}/children`,
    );
    return data.value;
  }

  async listByPath(folderPath: string, driveId?: string): Promise<DriveItem[]> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const encoded = encodeURIComponent(folderPath).replace(/%2F/g, "/");
    const data = await this.request<{ value: DriveItem[] }>(
      "GET",
      `/sites/${siteId}/drives/${dId}/root:/${encoded}:/children`,
    );
    return data.value;
  }

  // ── File read ────────────────────────────────────────────────────────────────

  async getItemByPath(filePath: string, driveId?: string): Promise<DriveItem> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, "/");
    return this.request<DriveItem>("GET", `/sites/${siteId}/drives/${dId}/root:/${encoded}`);
  }

  async readFileContent(filePath: string, driveId?: string): Promise<string> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, "/");
    const res = await this.requestRaw(
      "GET",
      `/sites/${siteId}/drives/${dId}/root:/${encoded}:/content`,
    );
    if (!res.ok) {
      let errBody: unknown;
      try { errBody = await res.json(); } catch { errBody = await res.text(); }
      throw new SharepointApiError(res.status, "GET", res.url, errBody);
    }
    return res.text();
  }

  // ── File write ───────────────────────────────────────────────────────────────

  async writeFile(filePath: string, content: string, driveId?: string): Promise<DriveItem> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, "/");
    const token = await this.getAccessToken();
    const url = `${GRAPH_BASE}/sites/${siteId}/drives/${dId}/root:/${encoded}:/content`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: content,
    });
    if (!res.ok) {
      let errBody: unknown;
      try { errBody = await res.json(); } catch { errBody = await res.text(); }
      throw new SharepointApiError(res.status, "PUT", url, errBody);
    }
    return res.json() as Promise<DriveItem>;
  }

  // ── Folder create ────────────────────────────────────────────────────────────

  async createFolder(parentPath: string, folderName: string, driveId?: string): Promise<DriveItem> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());

    let endpoint: string;
    if (!parentPath || parentPath === "/" || parentPath === "") {
      endpoint = `/sites/${siteId}/drives/${dId}/root/children`;
    } else {
      const encoded = encodeURIComponent(parentPath).replace(/%2F/g, "/");
      endpoint = `/sites/${siteId}/drives/${dId}/root:/${encoded}:/children`;
    }

    return this.request<DriveItem>("POST", endpoint, {
      name: folderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "rename",
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────────

  async searchFiles(query: string, driveId?: string): Promise<DriveItem[]> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const encoded = encodeURIComponent(query);
    const data = await this.request<{ value: DriveItem[] }>(
      "GET",
      `/sites/${siteId}/drives/${dId}/root/search(q='${encoded}')`,
    );
    return data.value;
  }

  // ── Delete ────────────────────────────────────────────────────────────────────

  async deleteItem(itemPath: string, driveId?: string): Promise<void> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const encoded = encodeURIComponent(itemPath).replace(/%2F/g, "/");
    await this.request<void>("DELETE", `/sites/${siteId}/drives/${dId}/root:/${encoded}`);
  }

  // ── Move / Rename ─────────────────────────────────────────────────────────────

  async moveItem(
    sourcePath: string,
    destFolderPath: string,
    newName?: string,
    driveId?: string,
  ): Promise<DriveItem> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const srcEncoded = encodeURIComponent(sourcePath).replace(/%2F/g, "/");

    // Get destination folder item id
    let parentRef: { driveId: string; path?: string; id?: string };
    if (!destFolderPath || destFolderPath === "/" || destFolderPath === "") {
      const drive = await this.request<{ id: string }>(
        "GET",
        `/sites/${siteId}/drives/${dId}`,
      );
      parentRef = { driveId: drive.id, path: "/drive/root" };
    } else {
      const destEncoded = encodeURIComponent(destFolderPath).replace(/%2F/g, "/");
      const destItem = await this.request<DriveItem>(
        "GET",
        `/sites/${siteId}/drives/${dId}/root:/${destEncoded}`,
      );
      parentRef = { driveId: dId, id: destItem.id };
    }

    const body: Record<string, unknown> = { parentReference: parentRef };
    if (newName) body.name = newName;

    return this.request<DriveItem>(
      "PATCH",
      `/sites/${siteId}/drives/${dId}/root:/${srcEncoded}`,
      body,
    );
  }

  // ── Excel (Workbook) API ──────────────────────────────────────────────────────

  private async getItemId(filePath: string, driveId?: string): Promise<{ itemId: string; dId: string; siteId: string }> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, "/");
    const item = await this.request<DriveItem>("GET", `/sites/${siteId}/drives/${dId}/root:/${encoded}`);
    return { itemId: item.id, dId, siteId };
  }

  async excelListSheets(filePath: string, driveId?: string): Promise<ExcelWorksheet[]> {
    const { itemId, dId, siteId } = await this.getItemId(filePath, driveId);
    const data = await this.request<{ value: ExcelWorksheet[] }>(
      "GET",
      `/sites/${siteId}/drives/${dId}/items/${itemId}/workbook/worksheets`,
    );
    return data.value;
  }

  async excelAddSheet(filePath: string, sheetName: string, driveId?: string): Promise<ExcelWorksheet> {
    const { itemId, dId, siteId } = await this.getItemId(filePath, driveId);
    return this.request<ExcelWorksheet>(
      "POST",
      `/sites/${siteId}/drives/${dId}/items/${itemId}/workbook/worksheets/add`,
      { name: sheetName },
    );
  }

  async excelReadRange(
    filePath: string,
    sheetName: string,
    address: string,
    driveId?: string,
  ): Promise<ExcelRange> {
    const { itemId, dId, siteId } = await this.getItemId(filePath, driveId);
    const sheetEncoded = encodeURIComponent(sheetName);
    const endpoint = address
      ? `/sites/${siteId}/drives/${dId}/items/${itemId}/workbook/worksheets('${sheetEncoded}')/range(address='${address}')`
      : `/sites/${siteId}/drives/${dId}/items/${itemId}/workbook/worksheets('${sheetEncoded}')/usedRange`;
    return this.request<ExcelRange>("GET", endpoint);
  }

  async excelWriteRange(
    filePath: string,
    sheetName: string,
    address: string,
    values: unknown[][],
    driveId?: string,
  ): Promise<ExcelRange> {
    const { itemId, dId, siteId } = await this.getItemId(filePath, driveId);
    const sheetEncoded = encodeURIComponent(sheetName);
    return this.request<ExcelRange>(
      "PATCH",
      `/sites/${siteId}/drives/${dId}/items/${itemId}/workbook/worksheets('${sheetEncoded}')/range(address='${address}')`,
      { values },
    );
  }
}
