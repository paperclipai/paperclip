import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

test("opens a task document keyed list alongside another document", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", {
    data: { name: `Document key ${randomUUID()}` },
  }));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Document cache test", status: "backlog" },
  }));
  const keys = ["report", "list"];
  for (const key of keys) {
    await json(await request.put(`/api/issues/${issue.id}/documents/${key}`, {
      data: { title: key, format: "markdown", body: `Saved body for ${key}` },
    }));
  }
  for (const key of keys) {
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}#document-${key}&viewer=full`);
    await expect(page.getByText(`Saved body for ${key}`, { exact: true }).first()).toBeVisible();
  }
});
