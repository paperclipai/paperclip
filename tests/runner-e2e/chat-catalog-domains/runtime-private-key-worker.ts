import { readFile } from "node:fs/promises";
import { chromium, test, type Cookie } from "@playwright/test";
import { containsPrivateCredential, type PrivateKeyReceipt } from "./runtime-private-key.js";
import { collectRunEvents } from "../run-observations.js";
interface Request { mode: "agent-key" | "canary"; baseURL: string; profileURL?: string; companyId?: string; agentId?: string; sourceIssueId?: string; cookies: Cookie[]; canary?: string; executablePath?: string; channel?: string }
async function main(): Promise<PrivateKeyReceipt> {
  let attached = false; try { test.info(); attached = true; } catch { /* expected in standalone process */ }
  if (attached) throw new Error("Private key worker cannot execute in Playwright Test");
  const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Request, base = new URL(input.baseURL);
  if (base.hostname !== "127.0.0.1" || base.protocol !== "http:" || !["agent-key", "canary"].includes(input.mode)) throw new Error("Private key target is not the isolated loopback instance");
  const receipt: PrivateKeyReceipt = { privateBrowserProcessIsolated: true, privateBrowserTestRunnerAttached: false, privateBrowserApiStepRecorder: false };
  const browser = await chromium.launch({ headless: true, ...(input.executablePath ? { executablePath: input.executablePath } : {}), ...(input.channel ? { channel: input.channel } : {}) });
  let keyId: string | undefined;
  const cookie = input.cookies.map(row => `${row.name}=${row.value}`).join("; ");
  async function response(suffix: string, options: RequestInit = {}) {
    const target = new URL(suffix, base); if (target.origin !== base.origin || !target.pathname.startsWith("/api/")) throw new Error("Private scan escaped its instance");
    return fetch(target, { redirect: "error", signal: AbortSignal.timeout(15_000), ...options, headers: { Cookie: cookie, Origin: base.origin, ...options.headers } });
  }
  async function json<T>(suffix: string): Promise<T> { const result = await response(suffix); if (!result.ok) { await result.body?.cancel(); throw new Error("Private public-resource scan failed"); } return result.json() as Promise<T>; }
  try {
    const context = await browser.newContext({ baseURL: base.origin }); await context.addCookies(input.cookies);
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    if (input.mode === "canary") {
      if (!input.canary || input.canary.length > 8192) throw new Error("Missing finite private canary");
      await page.setContent('<code></code><input type="password" aria-label="Synthetic private canary">');
      await page.getByLabel("Synthetic private canary").fill(input.canary);
      await page.locator("code").evaluate((node, value) => { node.textContent = value; }, input.canary);
      receipt.canaryContained = await page.locator("code").textContent() === input.canary;
      return receipt;
    }
    if (![input.agentId, input.companyId, input.sourceIssueId].every(id => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id)) || !input.profileURL || new URL(input.profileURL).origin !== base.origin) throw new Error("Invalid exact private key resource binding");
    await page.goto(input.profileURL, { waitUntil: "domcontentloaded" }); await page.getByRole("link", { name: /API keys/i }).click();
    await page.getByPlaceholder("Key name (e.g. production)").fill("local integration"); await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByText("API key created — copy it now, it will not be shown again.", { exact: true }).waitFor({ state: "visible" });
    const token = (await page.locator("code").filter({ hasText: /^pcp_/ }).first().textContent())?.trim();
    if (!token || token.length < 20) throw new Error("Missing private one-time credential");
    const identity = await fetch(new URL("/api/agents/me", base), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}` } });
    if (!identity.ok) { await identity.body?.cancel(); throw new Error("Human credential authentication failed"); }
    const actor = await identity.json() as { id: string; companyId: string };
    const keys = await json<Array<{ id: string; name: string; revokedAt: string | null }>>(`/api/agents/${input.agentId}/keys`), created = keys.filter(row => row.name === "local integration" && !row.revokedAt);
    if (created.length !== 1) throw new Error("Human key operation did not create exactly one key");
    keyId = created[0]!.id; receipt.createdKey = { id: keyId, name: "local integration", revokedAt: null };
    receipt.createdKeyAgentId = actor.id; receipt.createdKeyCompanyId = actor.companyId; receipt.humanCreated = true; receipt.tokenShownOnce = true;
    await page.getByRole("button", { name: "Dismiss", exact: true }).click(); await page.reload({ waitUntil: "domcontentloaded" });
    receipt.tokenAbsentAfterReload = !(await page.locator("body").textContent())?.includes(token);
    await page.getByText("local integration", { exact: true }).locator("..").locator("..").getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByText("Revoked Keys", { exact: true }).waitFor({ state: "visible" });
    const denied = await fetch(new URL("/api/agents/me", base), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}` } });
    receipt.revokedCredentialStatus = denied.status; await denied.body?.cancel();
    try {
      const root = `/api/issues/${input.sourceIssueId}`, parts: unknown[] = [await json(`${root}/comments?order=asc`), await json(`/api/agents/${input.agentId}/keys`), await json(`/api/companies/${input.companyId}/activity?limit=1000`)];
      const documents = await json<Array<{ key: string }>>(`${root}/documents`);
      for (const doc of documents) { const url = `${root}/documents/${encodeURIComponent(doc.key)}`; parts.push(await json(url), await json(`${url}/revisions`)); }
      parts.push(await json(`${root}/work-products`));
      const attachments = await json<Array<{ id: string; byteSize: number }>>(`${root}/attachments`); parts.push(attachments);
      for (const attachment of attachments) {
        if (!Number.isSafeInteger(attachment.byteSize) || attachment.byteSize < 0 || attachment.byteSize > 1_048_576) throw new Error("Private attachment scan exceeded bound");
        const content = await response(`/api/attachments/${attachment.id}/content`); if (!content.ok) { await content.body?.cancel(); throw new Error("Private attachment read failed"); }
        parts.push(Buffer.from(await content.arrayBuffer()).toString("utf8"));
      }
      const runs = await json<Array<{ id: string }>>(`/api/companies/${input.companyId}/heartbeat-runs?limit=100`); parts.push(runs);
      if (runs.length >= 100) throw new Error("Private run scan requires complete bounded run inventory");
      let logBytes = 0;
      for (const run of runs) {
        parts.push(await json(`/api/heartbeat-runs/${run.id}`)); let offset = 0;
        for (;;) {
          const log = await json<{ content: string; nextOffset?: number }>(`/api/heartbeat-runs/${run.id}/log?offset=${offset}&limitBytes=1048576`);
          if (typeof log.content !== "string") throw new Error("Missing complete private run log");
          parts.push(log.content); logBytes += Buffer.byteLength(log.content); if (logBytes > 8_388_608) throw new Error("Private log scan exceeded bound");
          if (log.nextOffset === undefined) break; if (log.nextOffset <= offset) throw new Error("Private log pagination failed"); offset = log.nextOffset;
        }
        parts.push(await collectRunEvents((afterSeq, limit) => json(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`)));
      }
      receipt.tokenLeaked = containsPrivateCredential(parts, token); receipt.privateScanComplete = true; receipt.artifactScanComplete = true; receipt.runEvidenceScanComplete = true;
    } catch { receipt.privateScanComplete = false; receipt.artifactScanComplete = false; receipt.runEvidenceScanComplete = false; }
    return receipt;
  } finally {
    if (keyId && input.agentId) { try { const result = await response(`/api/agents/${input.agentId}/keys/${keyId}`, { method: "DELETE" }); await result.body?.cancel(); } catch { /* company cleanup retains final ownership */ } }
    await browser.close();
  }
}
main().then(value => process.stdout.write(JSON.stringify(value))).catch(() => { process.stderr.write("Private key operation failed; diagnostics withheld"); process.exitCode = 1; });
