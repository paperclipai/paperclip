import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

// Real document writes, activity delivery, query refresh, storage, and task UI.
// Board-owned tasks avoid invoking an agent merely to test presentation.
for (const mobile of [false, true]) {
  test(`artifact arrival preserves a closed panel and composer focus (mobile=${mobile})`, async ({ page, request }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const company = await json(await request.post("/api/companies", {
      data: { name: `Passive artifacts ${randomUUID()}` },
    }));
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Keep reading while an artifact arrives", status: "backlog" },
    }));
    await page.addInitScript(() => localStorage.setItem("paperclip:panel-visible", "false"));
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}?from=inbox&fromHref=%2Finbox%2Fmine`);
    await expect(page.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();
    const editor = page.getByTestId("task-chat-composer-input").getByRole("textbox", { name: "editable markdown" });
    await editor.fill("Keep my draft and focus");
    const updated = page.waitForResponse(async (response) => {
      if (response.request().method() !== "GET" || !/\/api\/issues\/[^/]+$/.test(new URL(response.url()).pathname)) return false;
      const data = await response.json().catch(() => null);
      return data?.id === issue.id && data.documentSummaries?.some((doc: { key: string }) => doc.key === "report");
    });
    await json(await request.put(`/api/issues/${issue.id}/documents/report`, {
      data: { title: "Arriving report", body: "# Arriving report\n\nDurable output.", format: "markdown" },
    }));
    await updated;
    // The response has reached the real query client; wait for React to commit.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(editor).toBeFocused();
    await expect(editor).toContainText("Keep my draft and focus");
    await expect(page.getByTestId("mobile-task-side-panel")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("paperclip:panel-visible"))).toBe("false");
    await page.screenshot({ path: testInfo.outputPath("artifact-arrived-panel-closed.png"), fullPage: true });

    if (mobile) {
      await page.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("button", { name: "Properties", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Show properties", exact: true }).click();
    }
    const panel = mobile ? page.getByTestId("mobile-task-side-panel") : page.locator("aside").filter({ has: page.getByRole("tab", { name: "Artifacts", exact: true }) });
    const artifacts = panel.getByRole("tab", { name: "Artifacts", exact: true });
    await expect(artifacts).toBeVisible();
    await expect(artifacts).toHaveAttribute("aria-selected", "false");
    await artifacts.click();
    await expect(panel.getByText("Arriving report", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("artifact-opened-by-user.png"), fullPage: true });
  });
}
