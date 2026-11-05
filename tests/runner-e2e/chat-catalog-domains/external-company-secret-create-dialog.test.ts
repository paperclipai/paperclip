import { readFile } from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";
import { stripTypeScriptTypes } from "node:module";
import { expect, it } from "vitest";

it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY !== "1")("waits for the actual company create form to close while its details sheet stays open", async () => {
  const source = await readFile(new URL("./external-private-browser-worker.ts", import.meta.url), "utf8");
  const start = source.indexOf('    if(input.mode === "company-secret-create"){');
  const end = source.indexOf('    if (input.mode === "gateway-token-rotation")', start);
  expect(start >= 0 && end > start).toBe(true);
  const code = stripTypeScriptTypes(`async function operation(input:any,page:any){${source.slice(start, end)}}`);
  const operation = new Function(`${code};return operation`)() as (input: unknown, page: Page) => Promise<{ secretId: string; storageClean: boolean }>;
  const ui = await readFile(new URL("../../../ui/src/pages/Secrets.tsx", import.meta.url), "utf8");
  expect(ui).toContain('<DialogTitle>{editingDefinition ? "Edit user-provided secret" : "Create secret"}</DialogTitle>');
  expect(ui).toContain("setCreateOpen(false)");
  expect(ui).toContain("setDetailSelection(result.item.id)");
  const browser = await chromium.launch({ headless: true, ...(process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {}) });
  const companyId = "11111111-1111-4111-8111-111111111111", secretId = "22222222-2222-4222-8222-222222222222";
  try {
    for (const scenario of ["created", "failed POST", "missing form"]) {
      const page = await browser.newPage(); page.setDefaultTimeout(700);
      await page.route("**/*", async route => {
        if (route.request().method() === "POST") return route.fulfill({ status: scenario === "failed POST" ? 400 : 201, contentType: "application/json", body: JSON.stringify({ id: secretId }) });
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<button onclick="${scenario === "missing form" ? "" : "document.querySelector('#create').hidden=false"}">New secret</button><section id="create" role="dialog" aria-labelledby="create-title" hidden><h2 id="create-title">Create secret</h2><label for="new-secret-name">Name</label><input id="new-secret-name"><label for="new-secret-provider">Provider</label><select id="new-secret-provider"><option value="local_encrypted">Encrypted</option></select><label for="new-secret-value">Value</label><textarea id="new-secret-value"></textarea><button onclick="fetch('/api/companies/${companyId}/secrets',{method:'POST'}).then(r=>{if(r.status===201){document.querySelector('#create').remove();document.querySelector('#details').hidden=false}})">Create secret</button></section><section id="details" role="dialog" aria-labelledby="details-title" hidden><h2 id="details-title">Deployment API key</h2></section>` });
      });
      const result = operation({ mode: "company-secret-create", companyId, setupURL: "http://127.0.0.1:3300/RUN/company/settings/secrets", credential: "synthetic-private-value" }, page);
      if (scenario === "created") {
        expect(await result).toMatchObject({ secretId, storageClean: true });
        expect(await page.getByRole("dialog", { name: "Deployment API key", exact: true }).isVisible()).toBe(true);
      } else await expect(result).rejects.toThrow();
      await page.close();
    }
  } finally { await browser.close(); }
}, 15000);
