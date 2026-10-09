import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { expectTaskPanelTab, selectTaskPanelTab } from "./helpers/task-panel-tabs";

async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

for (const mobile of [false, true]) {
  test(`opens uploaded text in task tabs and downloads the original (mobile=${mobile})`, async ({ page, request }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const company = await json(await request.post("/api/companies", { data: { name: `Text files ${randomUUID()}` } }));
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Review uploaded text files", status: "backlog" },
    }));
    const files = [
      { name: "AGENTS.md", mimeType: "text/markdown", buffer: Buffer.from("# File charter\n\nKeep **original** bytes.\n") },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Plain text <script>never execute</script>\n") },
    ];
    const attachments = [];
    for (const file of files) attachments.push(await json(await request.post(`/api/companies/${company.id}/issues/${issue.id}/attachments`, { multipart: { file } })));
    await json(await request.post(`/api/issues/${issue.id}/comments`, {
      data: { body: "Review the attached files.", attachmentIds: attachments.map((attachment) => attachment.id) },
    }));
    for (const [index, attachment] of attachments.entries()) {
      await json(await request.post(`/api/issues/${issue.id}/work-products`, {
        data: {
          type: "artifact", provider: "paperclip", title: `Delivered ${files[index]!.name}`, status: "ready_for_review",
          metadata: {
            attachmentId: attachment.id, contentType: attachment.contentType, byteSize: attachment.byteSize,
            originalFilename: files[index]!.name, contentPath: attachment.contentPath,
            openPath: attachment.contentPath, downloadPath: `${attachment.contentPath}?download=1`,
          },
        },
      }));
    }
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
    await page.getByRole("link", { name: "Open AGENTS.md", exact: true }).click();
    const panel = mobile ? page.getByTestId("mobile-task-side-panel") : page.locator("aside").filter({ has: page.getByRole("tab", { name: "AGENTS.md", exact: true }) });
    await expectTaskPanelTab(panel, mobile, "AGENTS.md");
    await expect(panel.getByRole("heading", { name: "File charter", exact: true, level: 1 })).toBeVisible();
    const raw = panel.getByRole("button", { name: "Raw", exact: true });
    await raw.click();
    await expect(raw).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByLabel("AGENTS.md raw text")).toContainText("# File charter");
    await panel.getByRole("button", { name: "Rendered", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "File charter", exact: true, level: 1 })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("markdown-rendered.png"), fullPage: true });
    const markdownDownload = page.waitForEvent("download");
    await panel.getByRole("link", { name: "Download AGENTS.md", exact: true }).click();
    expect(await fs.readFile((await (await markdownDownload).path())!)).toEqual(files[0]!.buffer);
    if (mobile) await panel.getByRole("button", { name: "Close side panel", exact: true }).click();
    await page.getByRole("link", { name: "Open notes.txt", exact: true }).click();
    await expectTaskPanelTab(panel, mobile, "notes.txt");
    await expect(panel.getByLabel("notes.txt raw text")).toContainText("<script>never execute</script>");
    await expect(panel.getByRole("group", { name: "Markdown view", exact: true })).toHaveCount(0);
    const textDownload = page.waitForEvent("download");
    await panel.getByRole("link", { name: "Download notes.txt", exact: true }).click();
    expect(await fs.readFile((await (await textDownload).path())!)).toEqual(files[1]!.buffer);
    await page.screenshot({ path: testInfo.outputPath("plain-text-download.png"), fullPage: true });
    await selectTaskPanelTab(page, panel, mobile, "AGENTS.md");
    await expect(panel.getByRole("heading", { name: "File charter", exact: true, level: 1 })).toBeVisible();
    if (mobile) {
      await panel.getByRole("button", { name: /^Switch tabs, \d+ open$/ }).click();
      const overview = page.getByRole("dialog", { name: "Open tabs", exact: true });
      await expect(overview.getByRole("button", { name: "AGENTS.md", exact: true })).toHaveCount(1);
      await overview.getByRole("button", { name: "AGENTS.md", exact: true }).click();
    } else {
      await expect(panel.getByRole("tab", { name: "AGENTS.md", exact: true })).toHaveCount(1);
    }
    await panel.getByRole("button", { name: "Open a new tab", exact: true }).click();
    await page.getByRole("option", { name: /^Artifacts(?: Already open)?$/ }).click();
    const markdownCard = panel.getByRole("article").filter({ has: page.getByRole("heading", { name: "Delivered AGENTS.md", exact: true }) });
    const review = markdownCard.getByRole("button", { name: /^(Read|Close) document$/ });
    await review.click();
    await expect(review).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByRole("heading", { name: "File charter", exact: true, level: 1 })).toBeVisible();
    await expect(markdownCard).toContainText("revision 1");
    await expect(panel.getByRole("link", { name: "Download Delivered AGENTS.md", exact: true })).toBeVisible();
    const cardDownload = page.waitForEvent("download");
    const textCard = panel.getByRole("article").filter({ has: page.getByRole("heading", { name: "Delivered notes.txt", exact: true }) });
    await textCard.getByRole("link", { name: "Download file", exact: true }).click();
    expect(await fs.readFile((await (await cardDownload).path())!)).toEqual(files[1]!.buffer);
    await expectTaskPanelTab(panel, mobile, "Artifacts");
    await panel.getByRole("button", { name: "Open in tab: Delivered notes.txt", exact: true }).click();
    await expectTaskPanelTab(panel, mobile, "notes.txt");
    await selectTaskPanelTab(page, panel, mobile, "Artifacts");
    await panel.getByRole("button", { name: "Open in tab: Delivered AGENTS.md", exact: true }).click();
    await expectTaskPanelTab(panel, mobile, "AGENTS.md");
  });
}
