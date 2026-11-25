import { expect, test } from "@playwright/test";
import { json, setup } from "./agent-chat.shared";

test("resizes the docked task panel with the keyboard and retains its width", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const fixture = await setup(request, { agentCount: 1 });
  try {
    const task = await json(await request.post(`/api/companies/${fixture.company.id}/issues`, {
      data: { title: "Document panel", status: "backlog" },
    }));
    await page.goto(`/${fixture.company.issuePrefix}/issues/${task.identifier}`);
    await expect(page.getByRole("heading", { name: "Document panel", exact: true })).toBeVisible();
    const grip = page.getByRole("separator", { name: "Resize panel" });
    const openPanel = async () => {
      if (!(await grip.isVisible())) {
        await page.getByRole("button", { name: "Show properties", exact: true }).click();
      }
      await expect(grip).toBeVisible();
    };
    await openPanel();

    await grip.focus();
    await expect(grip).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(grip).not.toBeFocused();
    await page.keyboard.press("Tab");
    await expect(grip).toBeFocused();

    const initialWidth = Number(await grip.getAttribute("aria-valuenow"));
    await expect(grip).toHaveAttribute("aria-valuemax", "944");
    await page.keyboard.press("ArrowLeft");
    await expect(grip).toHaveAttribute("aria-valuenow", String(initialWidth + 16));
    await page.keyboard.press("Home");
    await expect(grip).toHaveAttribute("aria-valuenow", "260");
    await page.keyboard.press("ArrowRight");
    await expect(grip).toHaveAttribute("aria-valuenow", "260");
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(grip).toHaveAttribute("aria-valuemax", "1264");
    await page.keyboard.press("End");
    await expect(grip).toHaveAttribute("aria-valuenow", "1264");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Document panel", exact: true })).toBeVisible();
    await openPanel();
    await expect(grip).toHaveAttribute("aria-valuenow", "1264");
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(grip).toHaveAttribute("aria-valuemax", "944");
    await expect(grip).toHaveAttribute("aria-valuenow", "944");
  } finally {
    await fixture.restore();
  }
});
