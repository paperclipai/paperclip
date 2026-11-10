import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, test, expect } from "@playwright/test";
import type { PrivateIdentityOperation, PrivateIdentityReceipt } from "./identity-private-browser.js";
import { runIdentityWizardInPrivateBrowser } from "./identity-wizard.js";
import { runNativeNewCompanyInPrivateBrowser } from "./identity-new-company-native.js";
let privateValues: string[] = [];
async function main(): Promise<PrivateIdentityReceipt> {
  try { test.info(); throw new Error("Attached Test worker refused"); } catch (error) { if (error instanceof Error && error.message === "Attached Test worker refused") throw error; }
  const request = process.argv[2]!; const directory = path.dirname(request);
  const input = JSON.parse(await readFile(request, "utf8")) as PrivateIdentityOperation & { executablePath?: string; channel?: string };
  privateValues = [...input.cookies.map(cookie => cookie.value), ...(input.kind === "sign-in" ? [input.password] : [input.credential])].filter(Boolean);
  const origin = new URL(input.origin);
  if (origin.hostname !== "127.0.0.1" || origin.protocol !== "http:" || new URL(input.startPath, origin).origin !== origin.origin) throw new Error("Private identity target must be a disposable loopback instance");
  if (!["sign-in", "wizard", "new-company-native", "observability", "canary-failure"].includes(input.kind)) throw new Error("Unknown finite identity operation");
  const browser = await chromium.launch({ headless: true, ...(input.executablePath ? { executablePath: input.executablePath } : {}), ...(input.channel ? { channel: input.channel } : {}) });
  try {
    const context = await browser.newContext({ baseURL: origin.origin }); await context.addCookies(input.cookies); const page = await context.newPage(); page.setDefaultTimeout(30_000);
    const receipt: PrivateIdentityReceipt = { operation: input.kind, completed: true, processIsolation: true, testRunnerAttached: false, apiStepRecorder: false, tracingEnabled: false, videoEnabled: false };
    if (input.kind === "canary-failure") {
      await page.setContent('<input type="password" aria-label="Private credential">');
      await page.getByLabel("Private credential", { exact: true }).fill(input.credential);
      if (await page.getByLabel("Private credential", { exact: true }).inputValue() !== input.credential) throw new Error("Private canary entry failed");
      // Deliberate failed API call reproduces the proven leak trigger, only here
      // outside the Test recorder. The parent receives a constant failure.
      let observed = false;
      try { await page.getByLabel("Deliberately absent credential field").fill(input.credential, { timeout: 25 }); }
      catch (error) { observed = error instanceof Error && error.name === "TimeoutError"; }
      if (!observed) throw new Error("Expected private failed-call canary was not exercised");
      receipt.failedApiCallObserved = true; return receipt;
    }
    await page.goto(new URL(input.startPath, origin).href, { waitUntil: "domcontentloaded" });
    if (input.kind === "sign-in") {
      if (!input.returnPath.startsWith("/") || input.returnPath.startsWith("//")) throw new Error("Invalid human return path");
      await page.getByLabel("Email", { exact: true }).fill(input.email); await page.getByLabel("Password", { exact: true }).fill(input.password);
      await page.getByRole("button", { name: "Sign In", exact: true }).click(); await expect(page).toHaveURL(new URL(input.returnPath, origin).href);
      await writeFile(path.join(directory, "storage.json"), JSON.stringify(await context.storageState()), { mode: 0o600 });
    } else if (input.kind === "new-company-native") {
      const connections: Array<{ companyId: string; connectionId: string; grantId: string }> = [];
      receipt.newCompany = await runNativeNewCompanyInPrivateBrowser({ ...input, page, onCompany() {}, onConnection() {},
        async registerCompany(company) { await writeFile(path.join(directory, "company.json"), JSON.stringify({ id: company.id }), { mode: 0o600 }); },
        async registerConnection(companyId, connectionId, grantId) { connections.push({ companyId, connectionId, grantId }); await writeFile(path.join(directory, "connections.json"), JSON.stringify(connections), { mode: 0o600 }); }, evidence: async () => {} });
    } else if (input.kind === "wizard") {
      receipt.wizard = await runIdentityWizardInPrivateBrowser({ ...input, page, onCompany: company => { void company; },
        async registerCompany(company) { await writeFile(path.join(directory, "company.json"), JSON.stringify({ id: company.id }), { mode: 0o600 }); }, evidence: async () => {} });
    } else {
      const section = page.locator('section[aria-labelledby="agent-observability-heading"]');
      await section.getByLabel("Destination", { exact: true }).selectOption("otlp"); await section.getByLabel("OTLP base URL", { exact: true }).fill(input.endpoint);
      await section.getByRole("button", { name: "Add header", exact: true }).click(); await section.getByRole("textbox", { name: "Header name", exact: true }).fill("Authorization");
      await section.getByLabel("Value for Authorization", { exact: true }).fill(input.credential);
      await section.getByRole("switch", { name: "Enable export", exact: true }).setChecked(true); await section.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(section.getByRole("button", { name: "Test saved settings", exact: true })).toBeEnabled();
    }
    return receipt;
  } finally { await browser.close(); }
}
main().then(receipt => { const output = JSON.stringify(receipt); if (privateValues.some(value => [value, encodeURIComponent(value), Buffer.from(value).toString("base64")].some(encoded => output.includes(encoded)))) throw new Error("Private identity receipt contains a credential"); process.stdout.write(output); }).catch(() => { process.stderr.write("Private identity browser operation failed; details withheld"); process.exitCode = 1; });
