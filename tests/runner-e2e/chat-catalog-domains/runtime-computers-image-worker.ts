import { readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";

import { chromium, test } from "@playwright/test";
import type { ImagePreparationRequest, ImagePreparationReceipt } from "./runtime-computers-image-private.js";
import type { EnvironmentCustomImageSetupSession, EnvironmentCustomImageTemplate, EnvironmentCustomImageTerminalSessionToken } from "../../../packages/shared/src/validators/environment-custom-images.js";
let phase: "input" | "session" | "terminal-token" | "browser" | "terminal" | "capture" | "saved-proof" = "input";
async function main(): Promise<ImagePreparationReceipt> {
  let attached = false; try { test.info(); attached = true; } catch { /* standalone operator child */ } if (attached) throw new Error("Image terminal cannot run inside Test");
  const r = JSON.parse(await readFile(process.argv[2]!, "utf8")) as ImagePreparationRequest & { executablePath: string }, base = new URL(r.baseURL);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || ![r.companyId, r.environmentId].every(x => /^[a-f0-9-]{36}$/i.test(x))) throw new Error("Invalid owned image binding");
  const headers = { Cookie: r.cookies.map(x => `${x.name}=${x.value}`).join("; "), Origin: base.origin, "Content-Type": "application/json" };
  async function api<T>(pathname: string, body?: unknown) {
    const response = await fetch(new URL(pathname, base), { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(300000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Image operator public action rejected"); } return response.json() as Promise<T>;
  }
  let sessionId: string | undefined, promoted = false;
  try {
    phase = "session"; const start = await api<{ session: EnvironmentCustomImageSetupSession }>(`/api/environments/${r.environmentId}/custom-image-setup-sessions?companyId=${r.companyId}`, { ttlSeconds: 600 }); sessionId = start.session.id;
    if (start.session.environmentId !== r.environmentId || !start.session.startedByUserId || start.session.startedByAgentId || start.session.status !== "waiting_for_user") throw new Error("Actual owned human setup session is not interactive");
    phase = "terminal-token"; const token = await api<EnvironmentCustomImageTerminalSessionToken>(`/api/environment-custom-image-setup-sessions/${sessionId}/terminal-session-token?companyId=${r.companyId}`, {});
    const url = new URL(token.websocketPath, base); if (url.origin !== base.origin || token.setupSessionId !== sessionId || token.environmentId !== r.environmentId) throw new Error("Terminal token is not the exact setup session"); url.protocol = "ws:";
    const nonce = randomBytes(12).toString("hex"), marker = `__PC_${nonce}_TOOLS_OK__`;
    phase = "browser"; const browser = await chromium.launch({ headless: true, executablePath: r.executablePath });
    try {
      const context = await browser.newContext(); await context.addCookies(r.cookies); const page = await context.newPage(); await page.goto(base.origin);
      phase = "terminal";
      // A literal browser script avoids TS-loader helper references crossing CDP.
      const script = String.raw`(({ url, token, nonce, marker }) => new Promise((resolve, reject) => {
        const socket = new WebSocket(url); let output = "", settled = false;
        const timeout = setTimeout(() => finish(new Error("Actual image tools timed out")), 120000);
        function finish(error) { if (settled) return; settled = true; clearTimeout(timeout); socket.close(); error ? reject(error) : resolve(); }
        socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token }));
        socket.onmessage = event => { let frame; try { frame = JSON.parse(String(event.data)); } catch { return; }
          if (frame.type === "ready") socket.send(JSON.stringify({ type: "input", data: "(node --version && npm --version && git --version) && printf '\\n__PC_%s_TOOLS_OK__\\n' '" + nonce + "'\r" }));
          if (frame.type === "error") finish(new Error("Actual setup terminal rejected"));
          if (frame.type === "output" && typeof frame.data === "string") { output += frame.data; if (output.length > 262144) return finish(new Error("Private output bound exceeded")); if (output.includes(marker) && /v\d+\.\d+\.\d+/.test(output) && /git version \d+\./.test(output)) finish(); }
        }; socket.onerror = () => finish(new Error("Actual setup terminal disconnected")); socket.onclose = () => { if (!settled) finish(new Error("Actual setup terminal closed early")); };
      }))`;
      await page.evaluate(`${script}(${JSON.stringify({ url: url.href, token: token.token, nonce, marker })})`);
    } finally { await browser.close(); }
    phase = "capture"; const finish = await api<{ session: EnvironmentCustomImageSetupSession; template: EnvironmentCustomImageTemplate }>(`/api/environment-custom-image-setup-sessions/${sessionId}/finish?companyId=${r.companyId}`, {});
    phase = "saved-proof"; const saved = await api<EnvironmentCustomImageSetupSession>(`/api/environment-custom-image-setup-sessions/${sessionId}?companyId=${r.companyId}`);
    if (finish.template.environmentId !== r.environmentId || finish.template.status !== "active" || !finish.template.templateRef || !finish.template.capturedAt || !finish.template.createdByUserId || finish.template.createdByAgentId || saved.status !== "promoted" || saved.promotedTemplateId !== finish.template.id) throw new Error("Actual provider image was not captured/promoted"); promoted = true;
    return { processIsolation: true, testRunnerAttached: false, sessionId, templateId: finish.template.id, templateRefSha256: createHash("sha256").update(finish.template.templateRef).digest("hex"), actualToolsVerified: true, promoted: true, sourceEnvironmentId: r.environmentId };
  } finally {
    if (sessionId && !promoted) await api(`/api/environment-custom-image-setup-sessions/${sessionId}/cancel?companyId=${r.companyId}`, { reason: "Owned eval operator setup cleanup" });
  }
}
main().then(x => process.stdout.write(JSON.stringify(x))).catch(() => { process.stderr.write(`image-private-phase:${phase}`); process.exitCode = 1; });
