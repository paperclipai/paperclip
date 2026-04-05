import { test, expect } from "@playwright/test";

const ISSUE_TITLE = "Visibility toggle regression";

test.describe("Issue visibility toggle", () => {
  test("hides and unhides an issue from the overflow menu", async ({ page }) => {
    await page.goto("/");
    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    const companyName = `${Math.random().toString(36).slice(2, 5).toUpperCase()}-${Date.now().toString(36)}`;
    let companyId: string | null = null;

    try {
      const companyRes = await page.request.post(`${baseUrl}/api/companies`, {
        data: {
          name: companyName,
        },
      });
      expect(companyRes.ok()).toBe(true);
      const company = await companyRes.json();
      companyId = company.id;

      const issueRes = await page.request.post(`${baseUrl}/api/companies/${company.id}/issues`, {
        data: {
          title: ISSUE_TITLE,
          status: "todo",
          priority: "high",
        },
      });
      expect(issueRes.ok()).toBe(true);
      const issue = await issueRes.json();

      await page.goto(`/issues/${issue.id}`);

      const overflowButton = page.getByRole("button", { name: "Issue actions" });
      await overflowButton.click();
      await page.getByRole("button", { name: "Hide this Issue" }).click();

      await expect(page).toHaveURL(/\/issues$/);

      const hiddenIssueRes = await page.request.get(`${baseUrl}/api/issues/${issue.id}`);
      expect(hiddenIssueRes.ok()).toBe(true);
      const hiddenIssue = await hiddenIssueRes.json();
      expect(hiddenIssue.hiddenAt).toBeTruthy();

      const visibleIssuesRes = await page.request.get(`${baseUrl}/api/companies/${company.id}/issues`);
      expect(visibleIssuesRes.ok()).toBe(true);
      const visibleIssues = await visibleIssuesRes.json();
      expect(visibleIssues.find((entry: { id: string }) => entry.id === issue.id)).toBeUndefined();

      await page.goto(`/issues/${issue.id}`);
      await expect(page.getByText("This issue is hidden")).toBeVisible();

      await overflowButton.click();
      await page.getByRole("button", { name: "Unhide this Issue" }).click();

      await expect(page).toHaveURL(new RegExp(`/issues/(?:${issue.id}|${issue.identifier})$`));
      await expect(page.getByText("This issue is hidden")).toHaveCount(0);

      const unhiddenIssueRes = await page.request.get(`${baseUrl}/api/issues/${issue.id}`);
      expect(unhiddenIssueRes.ok()).toBe(true);
      const unhiddenIssue = await unhiddenIssueRes.json();
      expect(unhiddenIssue.hiddenAt).toBeNull();

      const listedAgainRes = await page.request.get(`${baseUrl}/api/companies/${company.id}/issues`);
      expect(listedAgainRes.ok()).toBe(true);
      const listedAgain = await listedAgainRes.json();
      expect(listedAgain.find((entry: { id: string }) => entry.id === issue.id)).toBeTruthy();

      await overflowButton.click();
      await expect(page.getByRole("button", { name: "Hide this Issue" })).toBeVisible();
    } finally {
      if (companyId) {
        const companyDeleteRes = await page.request.delete(`${baseUrl}/api/companies/${companyId}`);
        expect(companyDeleteRes.ok()).toBe(true);
      }
    }
  });
});
