import type { GatewayConfig } from "./config.js";
import type { PaperclipIssue } from "./types.js";

export class PaperclipClient {
  constructor(private readonly config: GatewayConfig) {}

  private get headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.paperclipApiKey}`,
    };
  }

  private url(path: string): string {
    return `${this.config.paperclipApiUrl}${path}`;
  }

  async createIssue(params: {
    title: string;
    description: string;
    priority?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PaperclipIssue> {
    const res = await fetch(
      this.url(`/api/companies/${this.config.paperclipCompanyId}/issues`),
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          title: params.title,
          description: params.description,
          priority: params.priority || "medium",
          metadata: params.metadata,
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Paperclip createIssue failed (${res.status}): ${text}`);
    }

    return (await res.json()) as PaperclipIssue;
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const res = await fetch(this.url(`/api/issues/${issueId}/comments`), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ body }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Paperclip addComment failed (${res.status}): ${text}`);
    }
  }

  async getIssue(issueId: string): Promise<PaperclipIssue> {
    const res = await fetch(this.url(`/api/issues/${issueId}`), {
      method: "GET",
      headers: this.headers,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Paperclip getIssue failed (${res.status}): ${text}`);
    }

    return (await res.json()) as PaperclipIssue;
  }

  async registerWebhook(params: {
    url: string;
    events: string[];
    secret: string;
  }): Promise<{ id: string }> {
    const res = await fetch(
      this.url(`/api/companies/${this.config.paperclipCompanyId}/webhooks`),
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(params),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Paperclip registerWebhook failed (${res.status}): ${text}`);
    }

    return (await res.json()) as { id: string };
  }
}
