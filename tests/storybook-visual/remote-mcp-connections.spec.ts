import { test, expect, type Page } from "@playwright/test";

const providers = ["zapier", "arcade", "composio", "executor"] as const;
const go = async (page: Page, provider: string, story: string) => {
  await page.goto(`/iframe.html?id=apps-connections-${provider}--${story}&viewMode=story`);
  await expect(page.locator(`[data-remote-mcp-provider="${provider}"]`)).toBeVisible();
};

for (const provider of providers) {
  test(`${provider}: setup finishes at discovery; regular permissions, testing and lifecycle`, async ({ page, context }) => {
    const escapedRequests: string[] = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if ((["http:", "https:"].includes(url.protocol) && url.hostname !== "127.0.0.1") || url.pathname.includes(`/tool-connections/review-${provider}/`)) {
        escapedRequests.push(url.origin + url.pathname); await route.abort();
      } else await route.continue();
    });
    await go(page, provider, "complete-setup-journey");
    await expect(page.getByText("Step 1 of 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Any human in the organization", exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Any agent", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: "Just me", exact: true }).click();
    await page.getByRole("radio", { name: "Just agents I pick", exact: true }).click();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Select agents", exact: true }).click();
    await page.getByRole("checkbox", { name: "Allow Researcher", exact: true }).check();
    await page.getByRole("checkbox", { name: "Allow Operator", exact: true }).check();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Step 2 of 2", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Connection name", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Test/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Just me", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Use example configuration" }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    if (provider !== "zapier") {
      await expect(page.getByText(/Finish signing in to/)).toBeVisible();
      await page.getByRole("button", { name: "Complete sign-in (simulation)" }).click();
    }
    await expect(page.getByRole("heading", { name: "Actions", exact: true })).toBeVisible();
    await expect(page.getByText("Simulated action calls: 0")).toBeVisible();
    await expect(page.getByText(/Step \d of/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Finish setup|Skip test|Run test/ })).toHaveCount(0);
    for (const radio of await page.getByRole("radio", { name: /: Allowed$/ }).all()) await expect(radio).toBeChecked();
    const rows = page.locator("[data-action-id]");
    const firstId = await rows.first().getAttribute("data-action-id");
    const secondId = await rows.nth(1).getAttribute("data-action-id");
    const first = page.locator(`[data-action-id="${firstId}"]`);
    const second = page.locator(`[data-action-id="${secondId}"]`);
    await first.getByRole("button", { name: "Test", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /^Test / })).toBeVisible();
    await dialog.getByRole("button", { name: "Choose which agent to test as", exact: true }).click();
    await page.getByRole("button", { name: "Unassigned agent engineer", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Choose which agent to test as", exact: true }).click();
    await page.getByRole("button", { name: "Researcher engineer", exact: true }).click();
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await expect(dialog.getByText(/^Worked\./)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Simulated action calls: 1")).toBeVisible();
    await first.getByRole("radio", { name: /: Ask first$/ }).click();
    await second.getByRole("radio", { name: /: Off$/ }).click();
    await page.getByRole("button", { name: "Refresh actions", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Newly discovered tool: Allowed", exact: true })).toBeChecked();
    await expect(first.getByRole("radio", { name: /: Ask first$/ })).toBeChecked();
    await expect(second.getByRole("radio", { name: /: Off$/ })).toBeChecked();
    await page.getByRole("button", { name: "Connection settings", exact: true }).click();
    await page.getByRole("button", { name: "Who can use this connection", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Just me", exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Just agents I pick", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    if (provider !== "zapier") await page.getByRole("button", { name: "Complete sign-in (simulation)" }).click();
    await expect(first.getByRole("radio", { name: /: Ask first$/ })).toBeChecked();
    await expect(second.getByRole("radio", { name: /: Off$/ })).toBeChecked();
    await second.getByRole("button", { name: "Test", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Connection settings", exact: true }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByRole("button", { name: "Disconnect connection", exact: true }).click();
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Permissions", exact: true })).toBeDisabled();
    expect(escapedRequests).toEqual([]);
  });

  test(`${provider}: state matrix renders at desktop and narrow widths`, async ({ page, request }, testInfo) => {
    const index = await (await request.get("/index.json")).json();
    const ids = Object.keys(index.entries).filter((id) => id.startsWith(`apps-connections-${provider}--`));
    expect(ids.length).toBeGreaterThanOrEqual(18);
    expect(ids.some((id) => /empty-catalog|--test-|--paperclip-approval|--provider-approval/.test(id))).toBe(false);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const id of ids) {
        await test.step(`${width}: ${id}`, async () => {
          await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${width === 1280 ? "dark" : "light"}`);
          await expect(page.locator(`[data-remote-mcp-provider="${provider}"]`)).toBeVisible();
          await expect(page.locator(".sb-errordisplay")).toBeHidden();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (/--(initial-setup|connection-details|manage-tool-permissions)$/.test(id)) {
            await page.evaluate(() => document.fonts.ready);
            await page.screenshot({ path: testInfo.outputPath(`${id}-${width}.png`), fullPage: true, animations: "disabled" });
          }
        });
      }
    }
    expect(pageErrors).toEqual([]);
  });

  test(`${provider}: save and resume preserves credentials in memory and skips OAuth for tokens`, async ({ page }) => {
    await go(page, provider, "advanced-authentication");
    await page.getByRole("button", { name: "Use example configuration" }).click();
    const originalUrl = await page.getByLabel("MCP server URL", { exact: true }).inputValue();
    await page.getByRole("button", { name: "Save & exit", exact: true }).click();
    await page.getByRole("button", { name: "Resume setup", exact: true }).click();
    await expect(page.getByLabel("MCP server URL", { exact: true })).toHaveValue(originalUrl);
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).not.toContain("review-only-not-a-secret");
    expect(storage).not.toContain(originalUrl);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Actions", exact: true })).toBeVisible();
    await expect(page.getByText(/Finish signing in to/)).toHaveCount(0);
    await expect(page.getByText("Simulated action calls: 0")).toBeVisible();
  });
}

test("Cancel, invalid URL and retry keep the form usable by keyboard", async ({ page }) => {
  await go(page, "arcade", "connection-details");
  const url = page.getByLabel("MCP server URL", { exact: true });
  await url.fill("not-a-url");
  await url.press("Enter");
  await expect(page.getByText("Enter a valid MCP URL")).toBeVisible();
  await url.fill("https://arcade.example.invalid/review/mcp");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Finish signing in to Arcade")).toBeVisible();
  await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await expect(url).toHaveValue("https://arcade.example.invalid/review/mcp");
  await page.getByRole("button", { name: "Try again", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Complete sign-in (simulation)" }).click();
  await expect(page.getByRole("heading", { name: "Arcade", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Connection settings", exact: true })).toBeFocused();
});

test("Zapier has no browser sign-in state or OAuth option", async ({ page, request }) => {
  const index = await (await request.get("/index.json")).json();
  const ids = Object.keys(index.entries).filter((id) => id.startsWith("apps-connections-zapier--"));
  expect(ids.some((id) => /sign-in/.test(id))).toBe(false);
  await go(page, "zapier", "advanced-authentication");
  await expect(page.getByRole("option", { name: "Automatic (sign in if required)" })).toHaveCount(0);
});

for (const [action, headline] of [["Approve and resume", /^Worked\./], ["Decline", "Request declined"], ["Cancel request", "Request cancelled"]] as const) {
  test(`Executor provider handoff: ${action} continues the same execution`, async ({ page }) => {
    await go(page, "executor", "manage-tool-permissions");
    await page.getByLabel("Test response", { exact: true }).selectOption("provider");
    await page.getByRole("button", { name: "Test", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await expect(dialog.getByText("review-execution-001", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Run again", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog.getByText(headline)).toBeVisible();
    await expect(dialog.getByText("Approval needed in Executor", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Simulated action calls: 2")).toBeVisible();
  });
}

test("Regular permissions filter actions and open the shared test error/approval states", async ({ page }, testInfo) => {
  await go(page, "zapier", "manage-tool-permissions");
  await page.getByRole("button", { name: "Write 1", exact: true }).click();
  await expect(page.locator("[data-action-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "All 3", exact: true }).click();
  await page.getByRole("textbox", { name: "Find an action", exact: true }).fill("spreadsheet rows");
  await expect(page.locator("[data-action-id]")).toHaveCount(1);
  await page.getByLabel("Test response", { exact: true }).selectOption("error");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog.getByText("Review resource was not found. Check the arguments.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: /: Ask first$/ }).click();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog.getByText("Sent for your OK.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Simulated action calls: 1")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("radio", { name: /: Allowed$/ }).click();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("canonical-test-dialog-narrow.png"), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
