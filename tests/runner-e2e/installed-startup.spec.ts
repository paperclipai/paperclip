/** Credential-free proof of the real launcher/Playwright/WebServer chain. */
import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

test("installed controller serves health and UI without creating provider work", async ({ page, request, baseURL }) => {
  test.skip(process.env.PAPERCLIP_RUNNER_E2E_INSTALLED_STARTUP_ONLY !== "1");
  expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === baseURL ? route.continue() : route.abort("blockedbyclient");
  });
  const health = await request.get(`${baseURL}/api/health`);
  expect(health.ok()).toBe(true);
  const before = await request.get(`${baseURL}/api/companies`);
  expect(before.ok()).toBe(true); expect(await before.json()).toEqual([]);
  const response = await page.goto(baseURL!);
  expect(response?.ok()).toBe(true);
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.getByRole("heading", { name: "What is the name of your organization?", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
  const after = await request.get(`${baseURL}/api/companies`);
  expect(after.ok()).toBe(true); expect(await after.json()).toEqual([]);
  const output = process.env.PAPERCLIP_RUNNER_E2E_PRIVATE_DIR!;
  await page.screenshot({ path: path.join(output, "installed-startup-only.png"), fullPage: true });
  await writeFile(path.join(output, "installed-startup-only.json"), `${JSON.stringify({ status: "health_ui_zero_company_passed", qualified: false, providerCalls: 0, healthStatus: health.status(), uiStatus: response!.status(), companiesBefore: 0, companiesAfter: 0, pageErrors: errors }, null, 2)}\n`, { mode: 0o600 });
});
