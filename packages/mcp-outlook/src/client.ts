import type { OutlookMcpConfig } from "./config.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export interface MailFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
}

export interface EmailAddress {
  name: string;
  address: string;
}

export interface EmailMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress: EmailAddress };
  toRecipients?: { emailAddress: EmailAddress }[];
  ccRecipients?: { emailAddress: EmailAddress }[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  importance: string;
  webLink?: string;
  conversationId?: string;
  parentFolderId?: string;
}

export interface SendMailPayload {
  subject: string;
  body: string;
  toRecipients: string[];
  ccRecipients?: string[];
  isHtml?: boolean;
}

export interface DraftPayload extends SendMailPayload {
  isDraft: true;
}

export class OutlookApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly body: unknown,
  ) {
    const msg =
      typeof body === "object" && body !== null
        ? (((body as Record<string, unknown>)?.error as Record<string, unknown>)
            ?.message as string)
        : String(body);
    super(`Outlook API ${method} ${url} → ${status}: ${msg ?? "unknown error"}`);
    this.name = "OutlookApiError";
  }
}

export class OutlookClient {
  private tokenCache: TokenCache | null = null;

  constructor(private readonly config: OutlookMcpConfig) {}

  // ── Auth ─────────────────────────────────────────────────────────────────────

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
    this.tokenCache = { accessToken: data.access_token, expiresAt: now + data.expires_in * 1000 };
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
      throw new OutlookApiError(res.status, method, url, errBody);
    }
    if (res.status === 204 || res.status === 202) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private get mb(): string {
    return `/users/${this.config.mailbox}`;
  }

  // ── Folders ───────────────────────────────────────────────────────────────────

  async listFolders(): Promise<MailFolder[]> {
    const data = await this.request<{ value: MailFolder[] }>("GET", `${this.mb}/mailFolders?$top=50`);
    return data.value;
  }

  // ── Messages ──────────────────────────────────────────────────────────────────

  async listEmails(options: {
    folder?: string;
    top?: number;
    onlyUnread?: boolean;
    orderBy?: string;
  } = {}): Promise<EmailMessage[]> {
    const { folder = "inbox", top = 20, onlyUnread, orderBy = "receivedDateTime desc" } = options;
    const params = new URLSearchParams({
      $top: String(top),
      $orderby: orderBy,
      $select: "id,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead,isDraft,hasAttachments,importance,webLink,conversationId,parentFolderId",
    });
    if (onlyUnread) params.set("$filter", "isRead eq false");
    const data = await this.request<{ value: EmailMessage[] }>(
      "GET",
      `${this.mb}/mailFolders/${folder}/messages?${params}`,
    );
    return data.value;
  }

  async readEmail(messageId: string): Promise<EmailMessage> {
    return this.request<EmailMessage>(
      "GET",
      `${this.mb}/messages/${messageId}?$select=id,subject,body,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,isRead,isDraft,hasAttachments,importance,webLink,conversationId`,
    );
  }

  async searchEmails(query: string, top = 20): Promise<EmailMessage[]> {
    const params = new URLSearchParams({
      $search: `"${query}"`,
      $top: String(top),
      $select: "id,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead,importance,webLink",
    });
    const data = await this.request<{ value: EmailMessage[] }>(
      "GET",
      `${this.mb}/messages?${params}`,
    );
    return data.value;
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.request("PATCH", `${this.mb}/messages/${messageId}`, { isRead: true });
  }

  // ── Send / Draft ──────────────────────────────────────────────────────────────

  private buildMessagePayload(payload: SendMailPayload) {
    return {
      subject: payload.subject,
      body: {
        contentType: payload.isHtml ? "HTML" : "Text",
        content: payload.body,
      },
      toRecipients: payload.toRecipients.map((addr) => ({
        emailAddress: { address: addr },
      })),
      ccRecipients: (payload.ccRecipients ?? []).map((addr) => ({
        emailAddress: { address: addr },
      })),
    };
  }

  async sendEmail(payload: SendMailPayload): Promise<void> {
    await this.request("POST", `${this.mb}/sendMail`, {
      message: this.buildMessagePayload(payload),
      saveToSentItems: true,
    });
  }

  async createDraft(payload: SendMailPayload): Promise<EmailMessage> {
    return this.request<EmailMessage>("POST", `${this.mb}/messages`, {
      ...this.buildMessagePayload(payload),
      isDraft: true,
    });
  }

  async replyToEmail(messageId: string, replyBody: string, replyAll = false, isHtml = false): Promise<void> {
    const endpoint = replyAll
      ? `${this.mb}/messages/${messageId}/replyAll`
      : `${this.mb}/messages/${messageId}/reply`;
    if (isHtml) {
      await this.request("POST", endpoint, {
        message: { body: { contentType: "HTML", content: replyBody } },
        comment: "",
      });
    } else {
      await this.request("POST", endpoint, { comment: replyBody });
    }
  }

  async forwardEmail(messageId: string, toAddresses: string[], comment?: string): Promise<void> {
    await this.request("POST", `${this.mb}/messages/${messageId}/forward`, {
      toRecipients: toAddresses.map((addr) => ({ emailAddress: { address: addr } })),
      comment: comment ?? "",
    });
  }

  async moveEmail(messageId: string, destinationFolderId: string): Promise<EmailMessage> {
    return this.request<EmailMessage>("POST", `${this.mb}/messages/${messageId}/move`, {
      destinationId: destinationFolderId,
    });
  }

  async deleteEmail(messageId: string): Promise<void> {
    await this.request("DELETE", `${this.mb}/messages/${messageId}`);
  }

  async updateDraft(messageId: string, patch: Partial<SendMailPayload>): Promise<EmailMessage> {
    const body: Record<string, unknown> = {};
    if (patch.subject) body.subject = patch.subject;
    if (patch.body) body.body = { contentType: patch.isHtml ? "HTML" : "Text", content: patch.body };
    if (patch.toRecipients) body.toRecipients = patch.toRecipients.map((a) => ({ emailAddress: { address: a } }));
    if (patch.ccRecipients) body.ccRecipients = patch.ccRecipients.map((a) => ({ emailAddress: { address: a } }));
    return this.request<EmailMessage>("PATCH", `${this.mb}/messages/${messageId}`, body);
  }

  async sendDraft(messageId: string): Promise<void> {
    await this.request("POST", `${this.mb}/messages/${messageId}/send`);
  }

  // ── Attachments ───────────────────────────────────────────────────────────────

  async listAttachments(messageId: string): Promise<AttachmentMeta[]> {
    const data = await this.request<{ value: AttachmentMeta[] }>(
      "GET",
      `${this.mb}/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`,
    );
    return data.value;
  }

  async getAttachmentContent(messageId: string, attachmentId: string): Promise<FileAttachment> {
    return this.request<FileAttachment>(
      "GET",
      `${this.mb}/messages/${messageId}/attachments/${attachmentId}`,
    );
  }
}

export interface AttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

export interface FileAttachment extends AttachmentMeta {
  contentBytes: string; // base64
}
