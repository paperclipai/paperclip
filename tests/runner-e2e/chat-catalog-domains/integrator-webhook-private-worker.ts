import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHmac } from "node:crypto";
import { chromium, test, type Cookie } from "@playwright/test";
interface Request { baseURL: string; route: string; routineId: string; triggerId: string; setupPending: boolean; signingMode: string; nonce: string; cookies: Cookie[]; executablePath?: string; channel?: string }
async function main() {
  let attached = false; try { test.info(); attached = true; } catch { /* no Test worker */ } if (attached) throw new Error("Private webhook driver must be outside Test");
  const request = process.argv[2]!; const input = JSON.parse(await readFile(request, "utf8")) as Request; const base = new URL(input.baseURL);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !/^[a-f0-9-]{36}$/i.test(input.triggerId) || !/^[a-f0-9-]{36}$/i.test(input.routineId) || !input.route.endsWith(`/routines/${input.routineId}`)) throw new Error("Private webhook target is outside its exact disposable scope");
  const browser = await chromium.launch({ headless: true, ...(input.executablePath ? { executablePath: input.executablePath } : {}), ...(input.channel ? { channel: input.channel } : {}) });
  try {
    const context = await browser.newContext({ baseURL: base.origin }); await context.addCookies(input.cookies); const page = await context.newPage(); page.setDefaultTimeout(30_000);
    const url = new URL(input.route, base); if (input.setupPending) url.searchParams.set("triggerSetup", input.triggerId);
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    const rotated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/routine-triggers/${input.triggerId}/rotate-secret` && response.request().method() === "POST" && response.ok());
    if (input.setupPending) await page.getByRole("button", { name: "Generate new key", exact: true }).click();
    else { const card = page.getByRole("region", { name: "Webhook trigger", exact: true }); await card.getByRole("button", { name: "Edit webhook", exact: true }).click(); await card.getByRole("button", { name: "Replace key", exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: "Replace key", exact: true }).click(); }
    const material = await (await rotated).json() as { secretMaterial: { webhookSecret: string; webhookUrl: string } };
    const secret = material.secretMaterial.webhookSecret; const endpoint = new URL(material.secretMaterial.webhookUrl);
    if (!/^[a-f0-9]{48}$/i.test(secret) || endpoint.origin !== base.origin || !/^\/api\/routine-triggers\/public\/[^/]+\/fire$/.test(endpoint.pathname)) throw new Error("Unexpected one-time scoped webhook credential");
    await page.locator("code").filter({ hasText: secret }).first().waitFor({ state: "visible" });
    if (input.setupPending) { await page.getByRole("button", { name: "Check connection", exact: true }).click();
      const finished = page.waitForResponse(response => new URL(response.url()).pathname === `/api/routine-triggers/${input.triggerId}` && response.request().method() === "PATCH" && response.ok());
      await page.getByRole("button", { name: /^Finish (?:setup|without checking)$/ }).click(); await finished; }
    const cookie = input.cookies.map(value => `${value.name}=${value.value}`).join("; ");
    const readRuns = async () => { const response = await fetch(new URL(`/api/routines/${input.routineId}/runs`, base), { redirect: "error", headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error("Invocation proof unavailable"); return await response.json() as Array<{ id: string }>; };
    const before = await readRuns(); const payload = JSON.stringify({ event: "synthetic.test-service", delivery: input.nonce });
    const bad = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: "Bearer deliberately-invalid-eval-key", "idempotency-key": `${input.nonce}-bad` }, body: payload, signal: AbortSignal.timeout(15_000) }); const invalidStatus = bad.status; await bad.body?.cancel();
    const afterInvalid = await readRuns();
    const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": `${input.nonce}-valid` };
    if (["bearer", "app_webhook"].includes(input.signingMode)) headers.authorization = `Bearer ${secret}`;
    else if (["github_hmac", "fireflies_hmac"].includes(input.signingMode)) headers[input.signingMode === "github_hmac" ? "x-hub-signature-256" : "x-hub-signature"] = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    else if (input.signingMode === "hmac_sha256") { const timestamp = String(Math.floor(Date.now() / 1000)); headers["x-paperclip-timestamp"] = timestamp; headers["x-paperclip-signature"] = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`; }
    else throw new Error("Webhook did not require authenticated delivery");
    const accepted = await fetch(endpoint, { method: "POST", redirect: "error", headers, body: payload, signal: AbortSignal.timeout(15_000) });
    const validStatus = accepted.status; if (validStatus !== 202) throw new Error("Authenticated synthetic delivery was not accepted");
    const result = await accepted.json() as { id?: string; linkedIssueId?: string };
    await writeFile(path.join(path.dirname(request), "secret.txt"), secret, { mode: 0o600 });
    return { processIsolation: true, testRunnerAttached: false, credentialVisibleInHumanUI: true, setupFinished: true, invalidStatus, validStatus, invalidCreatedInvocation: afterInvalid.length !== before.length, invocationId: result.id, linkedIssueId: result.linkedIssueId, triggerId: input.triggerId };
  } finally { await browser.close(); }
}
main().then(receipt => process.stdout.write(JSON.stringify(receipt))).catch(() => { process.stderr.write("Private webhook operation failed; diagnostics withheld"); process.exitCode = 1; });
