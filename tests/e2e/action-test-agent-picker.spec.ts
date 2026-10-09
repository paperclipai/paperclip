import { expect, test, type APIResponse } from "@playwright/test";
import { startReviewProvider } from "../fixtures/connection-review-provider";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

test("action-test agent picker scrolls with the wheel and omits terminated agents", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const provider = await startReviewProvider();
  try {
    const company = await json(await request.post("/api/companies", { data: { name: `Agent picker QA ${Date.now()}` } }));
    for (let i = 0; i < 24; i++) {
      await json(await request.post(`/api/companies/${company.id}/agents`, {
        data: { name: `Picker agent ${String(i).padStart(2, "0")}`, role: "qa", adapterType: "process", adapterConfig: { command: "true" } },
      }));
    }
    const terminated = await json(await request.post(`/api/companies/${company.id}/agents`, {
      data: { name: "Terminated picker agent", role: "qa", adapterType: "process", adapterConfig: { command: "true" } },
    }));
    await json(await request.post(`/api/agents/${terminated.id}/terminate`));
    const connection = await json(await request.post(`/api/companies/${company.id}/tools/connections`, {
      data: { name: "Picker fixture", transport: "mcp_remote", config: { url: provider.url }, status: "active", enabled: true },
    }));
    await json(await request.post(`/api/tool-connections/${connection.id}/catalog/refresh`));
    await page.goto(`/${company.issuePrefix}/apps/${connection.id}/permissions`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Test", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Test List fixture pages" });
    await dialog.getByRole("button", { name: "Choose which agent to test as" }).click();
    const picker = page.locator('[data-slot="popover-content"]');
    const list = picker.locator(".overflow-y-auto");
    await expect(picker.getByRole("button", { name: "Terminated picker agent" })).toHaveCount(0);
    await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await list.hover();
    const start = await list.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(start);
    await picker.getByRole("textbox", { name: "Search agents" }).fill("Picker agent 23");
    await picker.getByRole("button", { name: /Picker agent 23/ }).click();
    await expect(dialog.getByRole("button", { name: "Choose which agent to test as" })).toHaveText("Picker agent 23");
    await expect(dialog).toBeVisible();
    expect(provider.captures.filter((capture) => capture.method === "tools/call")).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("agent-picker.png") });
  } finally { await provider.close(); }
});
