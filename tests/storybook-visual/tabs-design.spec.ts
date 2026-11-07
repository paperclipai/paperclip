import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 1100 } });
test("canonical tabs share filled selection with compact and standard type sizes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/iframe.html?id=design-tabs--playground&viewMode=story&globals=theme:dark");
  const preview = page.getByTestId("tabs-preview");
  await expect(preview.getByRole("region")).toHaveCount(2);
  for (const [name, size, height] of [["Standard", "14px", 32], ["Compact", "12px", 24]] as const) {
    const section = preview.getByRole("region", { name, exact: true });
    const paperclip = section.getByRole("tab", { name: "Paperclip", exact: true });
    await paperclip.focus();
    await page.keyboard.press("ArrowRight");
    const selected = section.getByRole("tab", { name: "Composio", exact: true });
    await expect(selected).toBeFocused();
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(section.getByRole("tabpanel", { name: "Composio", exact: true })).toBeVisible();
    await expect(selected).toHaveCSS("font-size", size);
    await expect(selected).toHaveCSS("font-weight", "400");
    expect(await selected.evaluate(element => element.getBoundingClientRect().height)).toBe(height);
    expect(await selected.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await selected.evaluate(element => getComputedStyle(element, "::after").display)).toBe("none");
  }
  const compact = preview.getByRole("region", { name: "Compact", exact: true });
  await compact.getByRole("radio", { name: "Videos", exact: true }).click();
  await expect(compact.getByRole("radio", { name: "Videos", exact: true })).toHaveAttribute("aria-checked", "true");
  await compact.getByRole("radio", { name: "Videos", exact: true }).click();
  await expect(compact.getByRole("radio", { name: "Videos", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(compact.getByText("Artifact type: video", { exact: true })).toBeVisible();
  await preview.getByRole("combobox", { name: "Tabs container width", exact: true }).selectOption("narrow");
  expect(await preview.getByTestId("tabs-specimens").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("disabled choices are unavailable in canonical tabs and segmented controls", async ({ page }) => {
  await page.goto("/iframe.html?id=design-tabs--playground&viewMode=story&globals=theme:dark");
  await expect(page.getByRole("radio", { name: "Restricted", exact: true })).toBeDisabled();
  await page.goto("/iframe.html?id=design-segmented-controllers--disabled&viewMode=story&globals=theme:dark");
  await expect(page.getByRole("tab", { name: "Agent Actions", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Activity", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Activity", exact: true })).toBeFocused();
});
