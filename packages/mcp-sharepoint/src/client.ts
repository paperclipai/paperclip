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
  private outlookTokenCache: TokenCache | null = null;
  private siteId: string | null = null;

  constructor(private readonly config: SharepointMcpConfig) {}

  // ── Auth ────────────────────────────────────────────────────────────────────

  private async fetchToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
    const now = Date.now();
    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token fetch failed ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    return Object.assign(data, { _expiresAt: now + data.expires_in * 1000 }).access_token;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.accessToken;
    }
    const token = await this.fetchToken(this.config.tenantId, this.config.clientId, this.config.clientSecret);
    // re-fetch gives us a new expires_in — store with a fixed 55-min window (tokens are 1h)
    this.tokenCache = { accessToken: token, expiresAt: now + 55 * 60 * 1000 };
    return token;
  }

  private async getOutlookAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.outlookTokenCache && this.outlookTokenCache.expiresAt > now + 60_000) {
      return this.outlookTokenCache.accessToken;
    }
    const { outlookTenantId, outlookClientId, outlookClientSecret } = this.config;
    const token = await this.fetchToken(
      outlookTenantId ?? this.config.tenantId,
      outlookClientId!,
      outlookClientSecret!,
    );
    this.outlookTokenCache = { accessToken: token, expiresAt: now + 55 * 60 * 1000 };
    return token;
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

  // ── Binary upload ────────────────────────────────────────────────────────────

  async uploadBinary(filePath: string, contentBase64: string, mimeType: string, driveId?: string): Promise<DriveItem> {
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, "/");
    const token = await this.getAccessToken();
    const url = `${GRAPH_BASE}/sites/${siteId}/drives/${dId}/root:/${encoded}:/content`;
    const bytes = Buffer.from(contentBase64, "base64");
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
      },
      body: bytes,
    });
    if (!res.ok) {
      let errBody: unknown;
      try { errBody = await res.json(); } catch { errBody = await res.text(); }
      throw new SharepointApiError(res.status, "PUT", url, errBody);
    }
    return res.json() as Promise<DriveItem>;
  }

  // ── Transfer from Outlook ────────────────────────────────────────────────────
  // Downloads an Outlook attachment as raw bytes server-side and uploads it to
  // SharePoint. Binary data never passes through the agent's context window.

  async transferFromOutlook(
    messageId: string,
    attachmentId: string,
    destPath: string,
    mimeType: string,
    driveId?: string,
  ): Promise<DriveItem & { transferredBytes: number }> {
    const { outlookClientId, outlookClientSecret, outlookMailbox } = this.config;
    if (!outlookClientId || !outlookClientSecret || !outlookMailbox) {
      throw new Error(
        "sharepoint_transfer_from_outlook requires OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, " +
        "and OUTLOOK_MAILBOX env vars to be set on the sharepoint MCP server.",
      );
    }

    const outlookToken = await this.getOutlookAccessToken();

    // Download raw bytes via /$value — no base64, no size limit
    const dlUrl = `${GRAPH_BASE}/users/${outlookMailbox}/messages/${messageId}/attachments/${attachmentId}/$value`;
    const dlRes = await fetch(dlUrl, {
      headers: { Authorization: `Bearer ${outlookToken}` },
    });
    if (!dlRes.ok) {
      let errBody: unknown;
      try { errBody = await dlRes.json(); } catch { errBody = await dlRes.text(); }
      throw new SharepointApiError(dlRes.status, "GET", dlUrl, errBody);
    }
    const bytes = Buffer.from(await dlRes.arrayBuffer());

    // Upload straight to SharePoint
    const siteId = await this.getSiteId();
    const dId = driveId ?? (await this.getDefaultDriveId());
    const encoded = encodeURIComponent(destPath).replace(/%2F/g, "/");
    const spToken = await this.getAccessToken();
    const upUrl = `${GRAPH_BASE}/sites/${siteId}/drives/${dId}/root:/${encoded}:/content`;
    const upRes = await fetch(upUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${spToken}`,
        "Content-Type": mimeType,
      },
      body: bytes,
    });
    if (!upRes.ok) {
      let errBody: unknown;
      try { errBody = await upRes.json(); } catch { errBody = await upRes.text(); }
      throw new SharepointApiError(upRes.status, "PUT", upUrl, errBody);
    }
    const item = await upRes.json() as DriveItem;
    return { ...item, transferredBytes: bytes.length };
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
