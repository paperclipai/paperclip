import type { HermesConnector, SendMessage } from "./types.js";

export class HttpHermesConnector implements HermesConnector {
  private base: string; private headers: Record<string, string>;
  constructor(cfg: { baseUrl: string; token?: string }) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) };
  }
  async send(msg: SendMessage): Promise<void> {
    const res = await fetch(`${this.base}/partner-bridge/send`, { method: "POST", headers: this.headers, body: JSON.stringify(msg) });
    if (res.status >= 400) throw new Error(`hermes send failed: ${res.status}`);
  }
}
