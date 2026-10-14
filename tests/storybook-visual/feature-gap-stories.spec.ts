import { assertRenderState } from "./feature-gap-render-states";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { generateStorybook } from "../../scripts/storybook-catalog.mjs";
const root = new URL("../../", import.meta.url).pathname;
const { catalog, stories: parsed } = generateStorybook(root, { write: false });
const suites = catalog.entries.filter(
  (entry: { stableId: string }) =>
    entry.stableId.startsWith("feature-") &&
    !entry.stableId.startsWith("feature-map-"),
);
let index: { entries: Record<string, { tags: string[] }> };
test.beforeAll(async ({ request }) => {
  const response = await request.get("/index.json");
  expect(response.ok()).toBe(true);
  index = await response.json();
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    const managerPath = info.outputPath("manager.txt");
    writeFileSync(managerPath, await page.locator("body").innerText());
    await info.attach("storybook-page", {
      path: managerPath,
      contentType: "text/plain",
    });
    const frame = page.frameLocator("#storybook-preview-iframe");
    const subjectPath = info.outputPath("subject.txt");
    writeFileSync(subjectPath, await frame.locator("body").innerText());
    await info.attach("storybook-subject", {
      path: subjectPath,
      contentType: "text/plain",
    });
  }
});
for (const suite of suites) {
  const file = parsed.find(
    (story: { file: string }) => story.file === suite.file,
  );
  if (!file) throw new Error(`Missing parsed story: ${suite.file}`);
  for (const id of file.ids) {
    test(id, async ({ page }, info) => {
      expect(
        index.entries[id],
        `Rebuild Storybook to include ${id}`,
      ).toBeDefined();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Opening an addon during play steals focus from inputs and dismisses menus.
      await page.goto(
        `/?path=/story/${id}&addonPanel=storybook/interactions/panel`,
      );
      const frame = page.frameLocator("#storybook-preview-iframe");
      await expect(frame.locator("body")).toHaveClass(/sb-show-main/);
      await expect(frame.locator(".sb-show-errordisplay")).toHaveCount(0);
      await expect(
        page.getByRole("tab", { name: /^Interactions/ }),
      ).toHaveAttribute("aria-selected", "true");
      const status = page.locator('[aria-label^="Story status:"]');
      if (index.entries[id]?.tags.includes("play-fn")) {
        await expect(status).toHaveAttribute(
          "aria-label",
          "Story status: Pass",
        );
      }
      if (!index.entries[id].tags.includes("play-fn"))
        await assertRenderState(frame, id);
      await expect(frame.locator("#storybook-root")).toBeAttached();
      expect(errors).toEqual([]);
      if (
        id.includes("accepted") ||
        id.includes("permission") ||
        id.includes("save-retention")
      )
        await page.screenshot({ path: info.outputPath(`${id}.png`) });
    });
  }
}

test("token fixtures reset when switching stories in one browser", async ({
  page,
}) => {
  await page.goto(
    "/?path=/story/feature-gateway-tokens--issued-token&addonPanel=storybook/interactions/panel",
  );
  await expect(
    page.getByRole("tab", { name: /^Interactions/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[aria-label^="Story status:"]')).toHaveAttribute(
    "aria-label",
    "Story status: Pass",
  );
  await page.getByRole("link", { name: "Active Token", exact: true }).click();
  const frame = page.frameLocator("#storybook-preview-iframe");
  await frame.getByRole("button", { name: /Token history/ }).click();
  await expect(
    frame.getByText("Preview client", { exact: true }).first(),
  ).toBeVisible();
  await expect(frame.getByText("Review client", { exact: true })).toHaveCount(
    0,
  );
});

test("draft fixtures reset when switching away from uncertain submission", async ({
  page,
}) => {
  await page.goto(
    "/?path=/story/feature-composer-draft-recovery--uncertain-submission&addonPanel=storybook/interactions/panel",
  );
  const frame = page.frameLocator("#storybook-preview-iframe");
  const warning = frame.getByRole("alert").filter({
    hasText: "We couldn’t confirm whether this comment was saved.",
  });
  const editor = frame.getByRole("textbox");
  await expect(warning).toContainText(
    "We couldn’t confirm whether this comment was saved.",
  );
  await page.getByRole("link", { name: "Empty", exact: true }).click();
  await expect(warning).toHaveCount(0);
  await expect(editor).toHaveText("");
  for (const story of ["Sent Clears Draft", "Send Failed Keeps Draft"]) {
    await page
      .getByRole("link", { name: "Uncertain Submission", exact: true })
      .click();
    await expect(warning).toContainText(
      "We couldn’t confirm whether this comment was saved.",
    );
    // Keep the browser/storage context, but reload for play stories so the
    // manager cannot report the previous no-play story's Pass during navigation.
    const id =
      story === "Sent Clears Draft"
        ? "sent-clears-draft"
        : "send-failed-keeps-draft";
    await page.goto(
      `/?path=/story/feature-composer-draft-recovery--${id}&addonPanel=storybook/interactions/panel`,
    );
    await expect(frame.locator("body")).toHaveClass(/sb-show-main/);
    await expect(editor).toBeVisible();
    await expect(warning).toHaveCount(0);
    await expect(page.locator('[aria-label^="Story status:"]')).toHaveAttribute(
      "aria-label",
      "Story status: Pass",
    );
    await expect(editor).toHaveText(
      story === "Sent Clears Draft"
        ? ""
        : "Review the release before publishing.",
    );
  }
});

for (const theme of ["light", "dark"]) {
  test(`backup retention renders on mobile in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/iframe.html?id=feature-backup-retention--current-policy&viewMode=story&globals=theme:${theme}`,
    );
    await expect(page.getByRole("button", { name: "14 days" })).toBeVisible();
    await expect(page.locator(".sb-show-errordisplay")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`backup-mobile-${theme}.png`),
    });
  });
}
