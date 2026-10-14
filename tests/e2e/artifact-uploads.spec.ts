import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";
import { expectTaskPanelTab } from "./helpers/task-panel-tabs";

// Real task UI, document revisions, attachment storage and pause holds.
// Only the explicit failed-upload response in the recovery test is injected.
async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function setup(page: Page, request: APIRequestContext, mobile = false) {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 });
  await page.addInitScript(() => localStorage.setItem("paperclip:panel-visible", "true"));
  const companies = await json(await request.get("/api/companies"));
  const company = companies.find((row: { name: string }) => row.name === "Artifact Upload Review") ?? await json(await request.post("/api/companies", { data: { name: `Artifact uploads ${randomUUID()}` } }));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: `Upload handoff files ${randomUUID().slice(0, 8)}`, status: "backlog", assigneeAgentId: null, assigneeUserId: null },
  }));
  await json(await request.post(`/api/issues/${issue.id}/tree-holds`, { data: { mode: "pause" } }));
  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}${mobile ? "?from=inbox&fromHref=%2Finbox%2Fmine" : ""}`);
  await expect(page.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();
  if (mobile) {
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("button", { name: "Properties", exact: true }).click();
  }
  const panel = mobile ? page.getByTestId("mobile-task-side-panel") : page.locator("aside").filter({ has: page.getByRole("button", { name: "Open a new tab", exact: true }) });
  await panel.getByRole("button", { name: "Open a new tab", exact: true }).click();
  await page.getByRole("option", { name: "Artifacts", exact: true }).click();
  await expectTaskPanelTab(panel, mobile, "Artifacts");
  await expect(panel.getByRole("button", { name: "Upload files", exact: true })).toBeVisible();
  return { company, issue, panel };
}

async function chooseFiles(page: Page, panel: Locator, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent("filechooser");
  await panel.getByRole("button", { name: "Upload files", exact: true }).click();
  await (await chooser).setFiles(files);
}

async function assertStillPaused(request: APIRequestContext, issueId: string) {
  const issue = await json(await request.get(`/api/issues/${issueId}`));
  expect(issue.status).toBe("backlog");
  expect(issue.assigneeAgentId).toBeNull();
  expect(issue.assigneeUserId).toBeNull();
  const state = await json(await request.get(`/api/issues/${issueId}/tree-control/state`));
  expect(state.activePauseHold).not.toBeNull();
  expect(await json(await request.get(`/api/issues/${issueId}/comments`))).toEqual([]);
  expect(await json(await request.get(`/api/issues/${issueId}/runs`))).toEqual([]);
}

for (const mobile of [false, true]) {
  test(`upload documents and files while a task remains paused (mobile=${mobile})`, async ({ page, request }, testInfo) => {
    const { issue, panel } = await setup(page, request, mobile);
    await chooseFiles(page, panel, [
      { name: "core-handoff.md", mimeType: "text/markdown", buffer: Buffer.from("# Engineering handoff\n\nStart with the loop inventory and preserve current task ownership.") },
      { name: "loop-inventory.csv", mimeType: "text/csv", buffer: Buffer.from("path,pattern\ndelivery,event-driven\nroutines,clock-driven") },
    ]);
    await expect(panel.getByRole("button", { name: "Read document", exact: true })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Download file", exact: true })).toBeVisible();
    await expectTaskPanelTab(panel, mobile, "Artifacts");
    const download = page.waitForEvent("download");
    await panel.getByRole("link", { name: "Download file", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("loop-inventory.csv");
    await panel.getByRole("button", { name: "Read document", exact: true }).click();
    await expect(panel.getByText("Start with the loop inventory and preserve current task ownership.", { exact: true })).toBeVisible();
    await assertStillPaused(request, issue.id);
    await page.reload();
    await expect(page.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();
    const documents = await json(await request.get(`/api/issues/${issue.id}/documents`));
    const attachments = await json(await request.get(`/api/issues/${issue.id}/attachments`));
    expect(documents).toHaveLength(1);
    expect(documents[0].key).toBe("core-handoff");
    expect(attachments).toHaveLength(1);
    expect(attachments[0].originalFilename).toBe("loop-inventory.csv");
    await assertStillPaused(request, issue.id);
    await page.screenshot({ path: testInfo.outputPath("uploaded-handoff-persisted.png"), fullPage: true });
  });
}

test("the entire populated panel accepts a drop and preserves an existing document", async ({ page, request }, testInfo) => {
  const { issue, panel } = await setup(page, request);
  await chooseFiles(page, panel, [{ name: "handoff.md", mimeType: "text/markdown", buffer: Buffer.from("# Original handoff\n\nPreserve this version.") }]);
  await expect(panel.getByRole("button", { name: "Read document", exact: true })).toBeVisible();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["# Additional handoff\n\nNew reference, separate document."], "handoff.md", { type: "text/markdown" }));
    data.items.add(new File(["Check saved deadlines before enabling instance sleep."], "verification.txt", { type: "text/plain" }));
    return data;
  });
  const header = panel.locator("[data-presentation] > header");
  await header.dispatchEvent("dragenter", { dataTransfer: transfer });
  const overlay = panel.locator("[data-artifact-drop-overlay]");
  await expect(overlay).toBeVisible();
  const frameBounds = await panel.locator("[data-presentation]").boundingBox();
  const overlayBounds = await overlay.boundingBox();
  expect(overlayBounds).toEqual(frameBounds);
  await page.screenshot({ path: testInfo.outputPath("entire-panel-dropzone.png"), fullPage: true });
  await header.dispatchEvent("dragleave", { dataTransfer: transfer });
  await expect(overlay).toBeHidden();
  await header.dispatchEvent("dragenter", { dataTransfer: transfer });
  await panel.locator("article").first().dispatchEvent("drop", { dataTransfer: transfer });
  await expect(panel.getByRole("button", { name: "Read document", exact: true })).toHaveCount(2);
  await expect(panel.getByText("verification.txt", { exact: true }).first()).toBeVisible();
  const documents = await json(await request.get(`/api/issues/${issue.id}/documents`));
  expect(documents.map((row: { key: string }) => row.key).sort()).toEqual(["handoff", "handoff-2"]);
  expect(documents.find((row: { key: string }) => row.key === "handoff").body).toContain("Preserve this version.");
  await assertStillPaused(request, issue.id);
});

test("a failed upload stays local and retry preserves the successful files", async ({ page, request }) => {
  const { issue, panel } = await setup(page, request);
  let fail = true;
  await page.route(`**/api/companies/*/issues/${issue.id}/attachments`, async route => {
    if (fail) { fail = false; await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "Upload failed. Try again." }) }); }
    else await route.continue();
  });
  await chooseFiles(page, panel, [
    { name: "failed-reference.txt", mimeType: "text/plain", buffer: Buffer.from("Reference restored after retry.") },
    { name: "saved-reference.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this successful file.") },
  ]);
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}/attachments`))).length).toBe(1);
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toBeHidden();
  await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}/attachments`))).map((row: { originalFilename: string }) => row.originalFilename).sort()).toEqual(["failed-reference.txt", "saved-reference.txt"]);
  await assertStillPaused(request, issue.id);
});

test("reserved filenames create visible documents without replacing internal revisions", async ({ page, request }) => {
  const { issue, panel } = await setup(page, request);
  const reserved = ["artifact-review-notes", "continuation-summary", "pipeline-case-body"];
  const originals = new Map<string, string>();
  for (const key of reserved) {
    const document = await json(await request.put(`/api/issues/${issue.id}/documents/${key}`, {
      data: { title: "Internal context", format: "markdown", body: `Preserve the internal ${key} document.`, baseRevisionId: null },
    }));
    originals.set(key, document.latestRevisionId);
  }
  await chooseFiles(page, panel, reserved.map(key => ({ name: `${key}.md`, mimeType: "text/markdown", buffer: Buffer.from(`# Uploaded ${key}\n\nThis reference must stay visible.`) })));
  await expect(panel.getByRole("button", { name: "Read document", exact: true })).toHaveCount(3);
  const documents = await json(await request.get(`/api/issues/${issue.id}/documents`));
  expect(documents.filter((row: { key: string }) => row.key.startsWith("upload-")).map((row: { key: string }) => row.key).sort()).toEqual(reserved.map(key => `upload-${key}`).sort());
  for (const key of reserved) {
    const document = await json(await request.get(`/api/issues/${issue.id}/documents/${key}`));
    expect(document.latestRevisionId).toBe(originals.get(key));
  }
  await assertStillPaused(request, issue.id);
});
