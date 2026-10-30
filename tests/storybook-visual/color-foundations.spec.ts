import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 1000 } });

async function openColors(page: Page, story: string) {
  await page.goto(`/iframe.html?id=design-foundations-colors--${story}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("color-foundations-preview")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
}

test("color reference reads the Paper palette and foreground focus color from the active CSS theme", async ({ page }, testInfo) => {
  await openColors(page, "token-reference");
  const expected = {
    foreground: "oklch(0.985 0 0)",
    background: "#1a1a1a",
    "background-alt": "oklch(0.145 0 0)",
    muted: "oklch(0.269 0 0)",
    "muted-highlight": "#333333",
    "muted-alt": "#202020",
    "muted-foreground": "oklch(0.708 0 0)",
    border: "oklch(1 0 0 / 10%)",
    ring: "oklch(0.985 0 0)",
    "focus-ring-halo": "color-mix(in srgb, oklch(0.985 0 0) 20%, transparent)",
  };
  await expect(page.locator("tr[data-token]")).toHaveCount(Object.keys(expected).length);
  for (const [name, value] of Object.entries(expected)) {
    await expect(page.locator(`tr[data-token="${name}"] [data-token-value]`)).toHaveText(value);
  }
  await expect(page.getByTestId("color-foundations-preview")).toHaveCSS("background-color", "rgb(26, 26, 26)");
  await page.screenshot({ path: testInfo.outputPath("color-token-reference.png"), fullPage: true });
});

test("shared cards use three surfaces and one border; inputs use background-alt", async ({ page }, testInfo) => {
  await openColors(page, "surfaces-and-elevation");
  for (const [level, color] of [["low", "rgb(26, 26, 26)"], ["middle", "rgb(32, 32, 32)"], ["high", "oklch(0.269 0 0)"]]) {
    const card = page.locator(`[data-slot="card"][data-elevation="${level}"]`);
    await expect(card).toHaveCSS("background-color", color);
    await expect(card).toHaveCSS("border-color", "oklch(1 0 0 / 0.1)");
  }
  await expect(page.locator('[data-pane="Left sidebar"]')).toHaveCSS("background-color", "oklch(0.269 0 0)");
  for (const field of [page.getByLabel("Task name"), page.getByLabel("Search tasks", { exact: true })]) {
    await expect(field).toHaveCSS("background-color", "oklch(0.145 0 0)");
    await expect(field).toHaveCSS("border-color", "oklch(1 0 0 / 0.1)");
  }
  await page.getByLabel("Task name").focus();
  await expect(page.getByLabel("Task name")).toHaveCSS("border-color", "oklch(0.985 0 0)");
  await expect.poll(() => page.getByLabel("Task name").evaluate(element => getComputedStyle(element).boxShadow)).toContain("/ 0.2)");
  expect(await page.getByLabel("Task name").evaluate(element => getComputedStyle(element).boxShadow)).toContain("3px");
  await page.screenshot({ path: testInfo.outputPath("color-surfaces-and-elevation.png"), fullPage: true });
});

test("task hover and portaled menus share the palette; production stories restore their theme", async ({ page }, testInfo) => {
  await openColors(page, "text-and-interaction");
  const row = page.locator('[data-slot="task-row"]').first();
  const title = row.locator('[data-slot="task-row-title"]');
  await expect(title).toHaveCSS("color", "oklch(0.708 0 0)");
  await expect(title).toHaveCSS("font-weight", "400");
  await row.hover();
  await expect(row).toHaveCSS("background-color", "oklch(0.269 0 0)");
  await expect(title).toHaveCSS("color", "oklch(0.985 0 0)");
  await expect(title).toHaveCSS("font-weight", "400");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Columns", exact: true });
  await expect(menu).toHaveCSS("background-color", "rgb(26, 26, 26)");
  await expect(menu).toHaveCSS("border-color", "oklch(1 0 0 / 0.1)");
  const option = menu.getByRole("menuitemcheckbox", { name: "Task ID", exact: true });
  await option.hover();
  await expect(option).toHaveCSS("background-color", "rgb(51, 51, 51)");
  await expect(option).toHaveCSS("color", "oklch(0.985 0 0)");
  await page.screenshot({ path: testInfo.outputPath("color-interaction-and-portal.png"), fullPage: true });
  await page.keyboard.press("Escape");

  // The CSS scope must disappear with its marker, even within the same document.
  await page.locator(".design-proposal-theme").evaluate(element => element.classList.remove("design-proposal-theme"));
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim())).toBe("oklch(0.205 0 0)");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted-alt").trim())).toBe("");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ring").trim())).toBe("oklch(0.556 0 0)");
  await page.goto("/iframe.html?id=foundations-primitive-matrix--all-primitives&viewMode=story&globals=theme:dark");
  await expect(page.getByRole("heading", { name: "Primitives and interaction states", exact: true })).toBeVisible();
  await expect(page.locator(".design-proposal-theme")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim())).toBe("oklch(0.205 0 0)");
});

test("light proposals inherit the production palette, including portaled menus", async ({ page }) => {
  const palette = () => page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground", "secondary", "muted", "muted-foreground", "accent", "border", "input", "ring", "sidebar"].map(name => [name, style.getPropertyValue(`--${name}`).trim()]));
  });
  await page.goto("/iframe.html?id=foundations-primitive-matrix--all-primitives&viewMode=story&globals=theme:light");
  await expect(page.getByRole("heading", { name: "Primitives and interaction states", exact: true })).toBeVisible();
  const production = await palette();
  await page.goto("/iframe.html?id=design-foundations-colors--token-reference&viewMode=story&globals=theme:light");
  await expect(page.getByTestId("color-foundations-preview")).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  expect(await palette()).toEqual(production);
  await expect(page.locator('tr[data-token="background"] [data-token-value]')).toHaveText(production.background);
  await page.goto("/iframe.html?id=design-foundations-colors--surfaces-and-elevation&viewMode=story&globals=theme:light");
  await expect(page.getByLabel("Task name")).toBeVisible();
  await expect(page.locator('[data-slot="card"][data-elevation="middle"]')).toHaveCSS("background-color", "oklch(0.97 0 0)");
  await page.getByLabel("Task name").focus();
  await expect(page.getByLabel("Task name")).toHaveCSS("outline-style", "solid");
  await page.goto("/iframe.html?id=design-foundations-colors--text-and-interaction&viewMode=story&globals=theme:light");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Columns", exact: true })).toHaveCSS("background-color", "oklch(1 0 0)");
  expect(await palette()).toEqual(production);
});
