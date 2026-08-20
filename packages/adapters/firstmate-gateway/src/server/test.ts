import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { WebSocket } from "ws";

export async function testEnvironment(context: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const url = typeof context.config.url === "string" ? context.config.url.trim() : "";
  const token = typeof context.config.authToken === "string" ? context.config.authToken.trim() : "";
  const checks: AdapterEnvironmentTestResult["checks"] = [];
  if (!url || !token) return { adapterType: "firstmate_gateway", status: "fail", testedAt: new Date().toISOString(), checks: [{ code: "config", level: "error", message: "FirstMate Gateway requires url and authToken." }] };
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 8_000 });
      socket.once("message", (raw) => { try { const frame = JSON.parse(String(raw)); if (frame.type === "hello") { socket.close(); resolve(); } else reject(new Error("unexpected relay response")); } catch { reject(new Error("invalid relay response")); } });
      socket.once("error", reject);
    });
    checks.push({ code: "relay_auth", level: "info", message: "Authenticated FirstMate relay handshake succeeded." });
    return { adapterType: "firstmate_gateway", status: "pass", testedAt: new Date().toISOString(), checks };
  } catch {
    return { adapterType: "firstmate_gateway", status: "fail", testedAt: new Date().toISOString(), checks: [{ code: "relay_auth", level: "error", message: "Could not authenticate to FirstMate Gateway." }] };
  }
}
