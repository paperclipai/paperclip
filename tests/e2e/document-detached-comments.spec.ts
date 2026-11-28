import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";

async function readJson(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("finds comments detached by a document revision", async ({ page, request }) => {
  const company = await readJson(await request.post("/api/companies", {
    data: { name: `Document review ${randomUUID()}` },
  }));
  try {
    const issue = await readJson(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Review the rollout", status: "backlog" },
    }));
    const documentPath = `/api/issues/${issue.id}/documents/rollout`;
    const annotationsPath = `${documentPath}/annotations`;
    const body = "Approve the staged rollout. Confirm the owner.";
    const original = await readJson(await request.put(documentPath, {
      data: { title: "Rollout", format: "markdown", body },
    }));

    const addThread = async (exact: string, feedback: string) => {
      const start = body.indexOf(exact);
      const end = start + exact.length;
      return readJson(await request.post(annotationsPath, {
        data: {
          baseRevisionId: original.latestRevisionId,
          baseRevisionNumber: original.latestRevisionNumber,
          selector: {
            quote: { exact },
            position: { normalizedStart: start, normalizedEnd: end, markdownStart: start, markdownEnd: end },
          },
          body: feedback,
        },
      }));
    };
    const open = await addThread("Approve the staged rollout.", "List the rollout reviewers.");
    const resolved = await addThread("Confirm the owner.", "Record the named owner.");

    await readJson(await request.put(documentPath, {
      data: { title: "Rollout", format: "markdown", body: "The schedule is ready.", baseRevisionId: original.latestRevisionId },
    }));
    for (const id of [open.id, resolved.id]) {
      const detached = await readJson(await request.get(`${annotationsPath}/${id}`));
      expect(detached.anchorState).toBe("orphaned");
    }
    await readJson(await request.patch(`${annotationsPath}/${resolved.id}`, { data: { status: "resolved" } }));

    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}#document-rollout&viewer=full`);
    const viewer = page.getByRole("tabpanel");
    await expect(viewer.getByText("The schedule is ready.", { exact: true })).toBeVisible();
    const comments = viewer.getByTestId("document-annotation-count-rollout");
    await expect(comments).toHaveAccessibleName("Open 1 unresolved comments on rollout", { timeout: 5_000 });
    await comments.click();

    const toggle = page.getByRole("button", { name: "Include detached comments (2)", exact: true });
    const openCard = page.getByRole("article", { name: "Approve the staged rollout.", exact: true });
    const resolvedCard = page.getByRole("article", { name: "Confirm the owner.", exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(openCard).toBeHidden();
    await expect(resolvedCard).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Detached · selected in revision 1", { exact: true })).toHaveCount(2);
    await openCard.click();
    await expect(openCard.getByText("List the rollout reviewers.", { exact: true })).toBeVisible();
    await resolvedCard.click();
    await expect(resolvedCard.getByText("Record the named owner.", { exact: true })).toBeVisible();
    await toggle.click();
    await expect(openCard).toBeHidden();
    await expect(resolvedCard).toBeHidden();
  } finally {
    await request.delete(`/api/companies/${company.id}`);
  }
});
