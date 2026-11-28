import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("copies and downloads the Markdown shown in task document viewers", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", {
    data: { name: `Document export ${randomUUID()}` },
  }));
  try {
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Export task documents", status: "backlog" },
    }));
    const plan = "# Rollout\n\n- **Review the plan** before rollout.";
    const handoff = "# Handoff\n\n**Résumé** and [notes](https://example.com).";
    const saveDocument = (key: string, title: string, body: string, baseRevisionId?: string) =>
      request.put(`/api/issues/${issue.id}/documents/${key}`, {
        data: { title, format: "markdown", body, baseRevisionId },
      });

    await json(await saveDocument("plan", "Rollout", plan));
    const original = await json(await saveDocument("handoff", "Handoff", handoff));
    await json(await saveDocument("handoff", "Handoff", "# Updated handoff", original.latestRevisionId));
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const taskPath = `/${company.issuePrefix}/issues/${issue.identifier}`;

    for (const { hash, key, body, rendered } of [
      { hash: "document-plan&viewer=full", key: "plan", body: plan, rendered: "Review the plan" },
      {
        hash: `document-handoff&viewer=full&revision=${original.latestRevisionId}`,
        key: "handoff",
        body: handoff,
        rendered: "Résumé",
      },
    ]) {
      await page.goto(`${taskPath}#${hash}`);
      const panel = page.getByRole("tabpanel");
      await expect(panel.getByText(rendered, { exact: true })).toBeVisible();
      await panel.getByRole("button", { name: "Copy Markdown", exact: true }).click({ timeout: 5_000 });
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(body);
      if (key === "plan") {
        const copied = panel.getByText("Copied", { exact: true });
        await expect(copied).toBeVisible();
        await expect(copied).toBeHidden({ timeout: 3_000 });
        await panel.getByRole("button", { name: "Copy Markdown", exact: true }).click();
        await expect(copied).toBeVisible();
      }
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        panel.getByRole("button", { name: "Download Markdown", exact: true }).click(),
      ]);
      expect(download.suggestedFilename()).toBe(`${key}.md`);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString("utf8")).toBe(body);
    }
  } finally {
    await request.delete(`/api/companies/${company.id}`);
  }
});
