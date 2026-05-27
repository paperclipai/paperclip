import type { GatewayConfig } from "./config.js";
import type { OutboundPayload } from "./types.js";
import { signPayload } from "./crypto.js";

export class BridgeClient {
  private bridgeUrls: Map<string, string> = new Map();

  constructor(private readonly config: GatewayConfig) {}

  registerBridge(platform: string, outboundUrl: string): void {
    this.bridgeUrls.set(platform, outboundUrl);
  }

  async sendOutbound(payload: OutboundPayload): Promise<void> {
    const url = this.bridgeUrls.get(payload.platform);
    if (!url) {
      throw new Error(`No bridge registered for platform: ${payload.platform}`);
    }

    const body = JSON.stringify(payload);
    const signature = signPayload(this.config.bridgeSharedSecret, body);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Signature": signature,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bridge outbound failed (${res.status}): ${text}`);
    }
  }
}
