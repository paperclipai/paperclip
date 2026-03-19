import { test, expect } from "@playwright/test";

/**
 * E2E regression: plain pasted URLs in the comment editor.
 *
 * The `linkPlugin` in MarkdownEditor.tsx must NOT auto-convert a pasted URL
 * to a markdown hyperlink. Without `disableAutoLink: true`, pasting
 * "https://example.com/foo" produces "[https://example.com/foo](https://example.com/foo)"
 * in the saved comment body.
 *
 * Clipboard-based paste is only reliably testable in Chromium; the Playwright
 * config already limits projects to Chromium so the skip guard here is a
 * belt-and-suspenders note of intent, not a gate against real cross-browser gaps.
 */

const TEST_URL = "https://github.com/Viraforge/paperclip/pull/17";

test.describe("Comment editor URL paste", () => {
  test("preserves plain URL without auto-converting to markdown link", async ({
    page,
    context,
    browserName,
  }) => {
    // Clipboard paste flow verified in Chromium only (intentional scope, not a gap).
    test.skip(browserName !== "chromium", "Clipboard paste flow verified in Chromium only");

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    const baseUrl = `http://127.0.0.1:${process.env.PAPERCLIP_E2E_PORT ?? 3100}`;

    // --- Setup: create a fresh company and issue via API ---
    // The local dev server runs in local_trusted mode (no auth required).
    const companyRes = await page.request.post(`${baseUrl}/api/companies`, {
      data: {
        name: `URL-Paste-Test-${Date.now()}`,
        issuePrefix: "UPT",
      },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    const issueRes = await page.request.post(
      `${baseUrl}/api/companies/${company.id}/issues`,
      {
        data: {
          title: "URL paste regression issue",
          status: "todo",
        },
      }
    );
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    // --- Navigate to the issue detail page ---
    await page.goto(`${baseUrl}/${company.issuePrefix}/issues/${issue.identifier}`);
    await expect(
      page.locator("h1, h2").filter({ hasText: issue.title })
    ).toBeVisible({ timeout: 10_000 });

    // --- Paste a raw URL into the comment editor ---
    // The comment editor is the last contenteditable on the issue detail page.
    const commentEditor = page.locator('[contenteditable="true"]').last();
    await commentEditor.click();

    // Write TEST_URL to the clipboard and paste it.
    await page.evaluate((url) => navigator.clipboard.writeText(url), TEST_URL);
    await page.keyboard.press("ControlOrMeta+V");

    // Allow the editor's paste handler to process.
    await page.waitForTimeout(600);

    // Submit the comment.
    await page.getByRole("button", { name: "Comment" }).click();
    await expect(
      page.locator("button", { hasText: "Posting..." })
    ).not.toBeVisible({ timeout: 5_000 });

    // --- Verify: the saved body is the plain URL, not a markdown hyperlink ---
    const commentsRes = await page.request.get(
      `${baseUrl}/api/issues/${issue.id}/comments`
    );
    expect(commentsRes.ok()).toBe(true);
    const comments = await commentsRes.json();
    const lastComment = comments[comments.length - 1];

    // Body must contain the raw URL.
    expect(lastComment.body).toContain(TEST_URL);

    // Body must NOT be wrapped in markdown link syntax: [url](url)
    expect(lastComment.body).not.toMatch(
      /\[https?:\/\/[^\]]+\]\(https?:\/\/[^)]+\)/
    );
  });
});
