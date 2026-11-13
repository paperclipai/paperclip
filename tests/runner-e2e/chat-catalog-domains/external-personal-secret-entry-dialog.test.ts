import { expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { personalSecretEntryDialog } from "./external-personal-secret-entry-dialog.js";
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY !== "1")("observes the actual entry-dialog helper after save while the definition Sheet remains open", async () => {
  const browser = await chromium.launch({ headless: true, ...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {} }), page = await browser.newPage();
  const render = () => page.setContent('<section id="sheet" role="dialog" aria-label="Personal publishing credential" aria-hidden="true">Definition details</section><section id="entry" role="dialog"><h2>Set your value</h2><input aria-label="Value"><button>Save value</button></section>');
  try {
    await render();
    const entry = personalSecretEntryDialog(page);
    await entry.getByRole("heading", { name: /^Set your value/ }).waitFor();
    await entry.getByRole("textbox").fill("synthetic-model-free-value");
    let persisted = false;
    await page.route("**/api/private-fixture-save", async route => { persisted = true; await route.fulfill({ status: 201, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"id":"synthetic-saved-value"}' }); });
    await page.locator("#entry button").evaluate(button => button.addEventListener("click", async () => { const response = await fetch("https://paperclip.example/api/private-fixture-save", { method: "POST" }); if (response.status === 201) { document.querySelector("#entry")!.remove(); document.querySelector("#sheet")!.removeAttribute("aria-hidden"); } }));
    await entry.getByRole("button", { name: "Save value", exact: true }).click();
    await entry.waitFor({ state: "hidden", timeout: 300 });
    expect(persisted).toBe(true);
    expect(await page.locator("#entry").count()).toBe(0);
    expect(await page.locator("#sheet").isVisible()).toBe(true);
    await expect(page.getByRole("dialog").waitFor({ state: "hidden", timeout: 100 })).rejects.toThrow();
    await render();
    await page.unroute("**/api/private-fixture-save"); persisted = false;
    await page.route("**/api/private-fixture-save", route => route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" }, body: "failed" }));
    await page.locator("#entry button").evaluate(button => button.addEventListener("click", async () => { const response = await fetch("https://paperclip.example/api/private-fixture-save", { method: "POST" }); if (response.status === 201) document.querySelector("#entry")!.remove(); }));
    await personalSecretEntryDialog(page).getByRole("textbox").fill("synthetic-model-free-value");
    await personalSecretEntryDialog(page).getByRole("button", { name: "Save value", exact: true }).click();
    await expect(personalSecretEntryDialog(page).waitFor({ state: "hidden", timeout: 100 })).rejects.toThrow();
    expect(await page.locator("#entry").isVisible()).toBe(true);
    expect(persisted).toBe(false);
  } finally { await browser.close(); }
}, 10000);
