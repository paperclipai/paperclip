import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

for (const mode of ["desktop", "mobile", "classic"] as const) {
  test(`document images share a gallery and deep links (${mode})`, async ({ page, request }, testInfo) => {
    const mobile = mode === "mobile";
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const settings = await json(await request.get("/api/instance/settings/experimental"));
    try {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: mode === "classic" } }));
      const company = await json(await request.post("/api/companies", { data: { name: `Document gallery ${randomUUID()}` } }));
      const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
        data: { title: "Review the design document", status: "backlog" },
      }));
      const paths: string[] = [];
      for (const [index, title] of ["Plan the work", "Review the result", "Share the evidence"].entries()) {
        const encoded = await page.evaluate(({ index, title }) => {
          const canvas = document.createElement("canvas");
          canvas.width = 1000; canvas.height = 600;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = ["#e0e7ff", "#ccfbf1", "#fef3c7"][index]!;
          ctx.fillRect(0, 0, 1000, 600);
          ctx.fillStyle = "#111827";
          ctx.font = "bold 54px sans-serif";
          ctx.fillText(title, 65, 125);
          ctx.font = "24px sans-serif";
          ctx.fillText(`Design review · Step ${index + 1}`, 65, 180);
          for (let card = 0; card < 3; card++) {
            ctx.fillStyle = "#ffffff"; ctx.fillRect(65 + card * 295, 255, 260, 220);
            ctx.fillStyle = ["#4f46e5", "#0f766e", "#b45309"][index]!;
            ctx.fillRect(90 + card * 295, 285, 65, 12);
            ctx.fillStyle = "#d1d5db";
            ctx.fillRect(90 + card * 295, 340, 190, 10);
            ctx.fillRect(90 + card * 295, 370, 155, 10);
          }
          return canvas.toDataURL("image/png").split(",")[1]!;
        }, { index, title });
        const attachment = await json(await request.post(`/api/companies/${company.id}/issues/${issue.id}/attachments`, {
          multipart: { file: { name: `step-${index + 1}.png`, mimeType: "image/png", buffer: Buffer.from(encoded, "base64") } },
        }));
        paths.push(attachment.contentPath);
      }
      const saved = await json(await request.put(`/api/issues/${issue.id}/documents/design`, {
        data: { title: "Design review", format: "markdown", body: `# Design review\n\nSelect an image to review the sequence.\n\n![Plan the work](${paths[0]})\n\n![Review the result][review]\n\n![Share the evidence](${paths[2]})\n\n[review]: ${paths[1]}` },
      }));
      const taskPath = `/${company.issuePrefix}/issues/${issue.identifier}`;
      await page.goto(`${taskPath}#document-design&viewer=full`);
      const first = page.getByRole("button", { name: "Open image: Plan the work", exact: true }).first();
      await expect(first).toBeVisible();
      await first.click();
      const gallery = page.getByRole("dialog", { name: "Image gallery", exact: true });
      await expect(gallery).toBeVisible();
      await expect(gallery).toContainText("1 / 3");
      await expect(page).toHaveURL(/image=1/);
      await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
      await gallery.getByRole("img").click();
      await expect(gallery).toBeVisible();
      await page.keyboard.press("ArrowRight");
      await expect(gallery).toContainText("2 / 3");
      await expect(gallery.getByRole("img")).toHaveAttribute("src", paths[1]!);
      await expect(page).toHaveURL(/image=2/);
      await page.screenshot({ path: testInfo.outputPath("document-gallery.png"), fullPage: true });
      const sharedUrl = page.url();
      await gallery.getByRole("button", { name: "Next", exact: true }).click();
      await expect(gallery).toContainText("3 / 3");
      await page.keyboard.press("ArrowRight");
      await expect(gallery).toContainText("1 / 3");
      await gallery.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(gallery).toContainText("3 / 3");
      await page.keyboard.press("Escape");
      await expect(gallery).toBeHidden();
      await expect(first).toBeFocused();
      await expect(page).not.toHaveURL(/image=/);
      if (mobile) await expect(page.getByTestId("mobile-task-side-panel")).toBeVisible();
      await page.goto(sharedUrl);
      await expect(gallery).toContainText("2 / 3");
      await page.reload();
      await expect(gallery).toContainText("2 / 3");
      await gallery.getByRole("button", { name: "Close", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(gallery.getByRole("button", { name: "Previous", exact: true })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(gallery.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await gallery.getByRole("button", { name: "Close", exact: true }).click();
      await expect(gallery).toBeHidden();
      const revised = await json(await request.put(`/api/issues/${issue.id}/documents/design`, {
        data: { title: "Design review", body: "# New revision\n\nNo images.", format: "markdown", baseRevisionId: saved.latestRevisionId },
      }));
      expect(revised.latestRevisionId).not.toBe(saved.latestRevisionId);
      await page.goto(`${taskPath}#document-design&viewer=full&revision=${saved.latestRevisionId}&interaction=current-task-review&documentIssue=${issue.id}&image=3`);
      await expect(gallery).toContainText("3 / 3");
      await expect(gallery.getByRole("img")).toHaveAttribute("src", paths[2]!);
      await page.screenshot({ path: testInfo.outputPath("document-gallery-revision.png"), fullPage: true });
      await gallery.click({ position: { x: 5, y: 180 } });
      await expect(gallery).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`revision=${saved.latestRevisionId}`));
      await first.click();
      await expect(gallery).toContainText("1 / 3");
      await page.keyboard.press("ArrowRight");
      await expect(gallery).toContainText("2 / 3");
      await expect(page).toHaveURL(/interaction=current-task-review/);
      await expect(page).toHaveURL(/viewer=full/);
      await expect(page).toHaveURL(new RegExp(`documentIssue=${issue.id}`));
      await page.reload();
      await expect(gallery).toContainText("2 / 3");
      await gallery.getByRole("button", { name: "Close", exact: true }).click();
      if (mode === "classic") {
        await page.getByRole("button", { name: "Return to latest", exact: true }).click();
        await expect(page.getByRole("heading", { name: "New revision", exact: true })).toBeVisible();
        await page.goto(`${taskPath}#document-design&revision=${saved.latestRevisionId}&interaction=another-review&image=1`);
        await expect(gallery).toContainText("1 / 3");
        await gallery.getByRole("button", { name: "Close", exact: true }).click();
      }
      await page.goto(`${taskPath}#document-design&image=100`);
      await page.reload();
      await expect(page.getByRole("heading", { name: "New revision", exact: true })).toBeVisible();
      await expect(gallery).toBeHidden();
      if (mode === "desktop") {
        const owner = await json(await request.post(`/api/companies/${company.id}/issues`, { data: { title: "Document owner", status: "backlog" } }));
        const owned = await json(await request.put(`/api/issues/${owner.id}/documents/design`, { data: { title: "Owned review", body: saved.body, format: "markdown" } }));
        await page.goto(`${taskPath}#document-design&viewer=full&revision=${owned.latestRevisionId}&documentIssue=${owner.id}&image=2`);
        await expect(gallery).toContainText("2 / 3");
        await gallery.getByRole("button", { name: "Close", exact: true }).click();
        await json(await request.put(`/api/issues/${issue.id}/documents/local-images`, { data: { title: "Local images", body: saved.body, format: "markdown" } }));
        await page.goto(`${taskPath}#document-local-images&viewer=full`);
        await page.getByRole("button", { name: "Open image: Plan the work", exact: true }).click();
        await gallery.getByRole("button", { name: "Close", exact: true }).click();
        await page.locator(`[role="tab"][data-side-panel-tab-target="document:${owner.id}:design:${owned.latestRevisionId}"]`).click();
        await page.getByRole("button", { name: "Open image: Plan the work", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`documentIssue=${owner.id}`));
        await page.reload();
        await expect(gallery).toContainText("1 / 3");
      }
    } finally {
      await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: settings.enableClassicTaskInterface } });
    }
  });
}
