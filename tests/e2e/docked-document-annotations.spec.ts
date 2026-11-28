import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

test("keeps the passage readable while writing a document comment in docked Artifacts", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", {
    data: { name: `Document comments ${randomUUID()}` },
  }));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Document review", status: "backlog" },
  }));
  const documentPath = `/api/issues/${issue.id}/documents/review`;
  await json(await request.put(documentPath, {
    data: {
      title: "Review",
      body: "First paragraph.\n\nSelected paragraph.",
      format: "markdown",
      baseRevisionId: null,
    },
  }));

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
  await page.getByRole("button", { name: "Show properties", exact: true }).click();
  const panel = page.locator("aside").filter({
    has: page.getByRole("button", { name: "Open a new tab", exact: true }),
  });
  await panel.getByRole("option", { name: "Artifacts", exact: true }).click();

  const documentPanel = panel.locator("#document-review");
  const passage = documentPanel.locator("p").filter({ hasText: /^Selected paragraph\.$/ });
  await passage.evaluate((element) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await documentPanel.locator(".paperclip-doc-annotation-selection-toolbar button").click();
  await expect(page.getByPlaceholder("Write a comment…")).toBeVisible();
  expect(await passage.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(0);
});
