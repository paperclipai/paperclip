import { expect, test } from "@playwright/test";

// Exercise the generated guide through the built Storybook manager. These checks
// need no image baselines and do not imply production acceptance.
test("guide filters and opens an area without story examples", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?path=/story/overview-storybook-guide--coverage-guide");
  const frame = page.frameLocator("#storybook-preview-iframe");
  await expect(frame.getByRole("heading", { name: "Paperclip feature map" })).toBeVisible();
  await frame.getByRole("textbox", { name: "Find a feature or capability" }).fill("cli-operations");
  await frame.getByRole("link", { name: "CLI/API and local worktrees", exact: true }).click();
  await expect(page).toHaveURL(/feature-map-cli-operations--overview/);
  await expect(frame.getByRole("heading", { name: "CLI/API and local worktrees", exact: true })).toBeVisible();
  const capability = frame.locator("section#context");
  await expect(capability.getByText(/No cataloged example yet/)).toBeVisible();
  await capability.getByText("Verification scope", { exact: true }).click();
  await expect(capability.getByText("No authored story required for CLI profile/context selection.", { exact: true })).toBeVisible();
  await expect(capability.getByRole("link", { name: "context.ts", exact: true })).toHaveAttribute("href", "https://github.com/paperclipai/paperclip/blob/master/cli/src/commands/client/context.ts");
  await expect(frame.getByRole("link", { name: "Agent access contract" })).toHaveAttribute("href", /agent-access-map\/cli-operations\.md$/);
  expect(errors).toEqual([]);
});

test("capability order and related foundations links survive generation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?path=/story/feature-map-developer-labs--overview");
  const frame = page.frameLocator("#storybook-preview-iframe");
  await expect(frame.getByRole("navigation", { name: "Capabilities" }).getByRole("link")).toHaveText(["Design", "Interaction labs", "Performance", "Route gates"]);
  const design = frame.locator("section#design");
  const related = design.getByRole("link", { name: "Primitive Matrix", exact: true });
  await expect(related).toHaveAttribute("href", /foundations-primitive-matrix--/);
  await related.click();
  await expect(page).toHaveURL(/foundations-primitive-matrix--/);
  await expect(frame.locator("body")).toHaveClass(/sb-show-main/);
  await expect(frame.locator("#storybook-root")).not.toBeEmpty();
  expect(errors).toEqual([]);
});
