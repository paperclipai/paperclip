import { expect, test, type Page } from "@playwright/test";
import { assertGitHubJourneyCheck, assertGitHubJourneyTaskDone } from "./github-review-browser.js";

const expected = { repository: "fixture/repo", url: "https://github.com/fixture/repo/runs/123", headSha: "a".repeat(40), score: 2 };

async function openCheck(page: Page, input: { status?: string; score?: number; headSha?: string; unrelatedFailure?: boolean; url?: string } = {}) {
  const body = `<button style="display:none">Re-run failed checks</button>
    <section aria-label="Check run summary"><div id="check_run_123">
      <div class="border-bottom">Fixture bot / Paperclip Review <span>${input.status ?? "failed"} <time>2 minutes ago</time></span></div>
      <h2>${input.score ?? expected.score}/5</h2>
      <p>Reviewed commit: <code>${input.headSha ?? expected.headSha}</code></p>
      <p>Review rationale: failed tests are discussed in the summary.</p>
    </div></section>
    ${input.unrelatedFailure ? '<div id="check_run_456"><div class="border-bottom">Another check failed</div><h2>2/5</h2></div>' : ""}`;
  await page.route("https://github.com/**", route => route.fulfill({ contentType: "text/html", body }));
  await page.goto(input.url ?? expected.url);
}

test("accepts the visible failed check despite an earlier hidden re-run menu item", async ({ page }) => {
  await openCheck(page);
  await expect(page.getByText(/failed/i).first()).toBeHidden();
  await assertGitHubJourneyCheck(page, expected, 150);
});

test("rejects a successful check even when its narrative and another check say failed", async ({ page }) => {
  await openCheck(page, { status: "succeeded", unrelatedFailure: true });
  await expect(assertGitHubJourneyCheck(page, expected, 150)).rejects.toThrow();
});

test("rejects the wrong reviewed commit", async ({ page }) => {
  await openCheck(page, { headSha: "b".repeat(40) });
  await expect(assertGitHubJourneyCheck(page, expected, 150)).rejects.toThrow();
});

test("rejects a different score", async ({ page }) => {
  await openCheck(page, { score: 3 });
  await expect(assertGitHubJourneyCheck(page, expected, 150)).rejects.toThrow();
});

test("rejects a page for another repository", async ({ page }) => {
  await openCheck(page, { url: "https://github.com/foreign/repo/runs/123" });
  await expect(assertGitHubJourneyCheck(page, expected, 150)).rejects.toThrow();
});

test("rejects a check reference outside the configured repository", async ({ page }) => {
  const url = "https://github.com/foreign/repo/runs/123";
  await openCheck(page, { url });
  await expect(assertGitHubJourneyCheck(page, { ...expected, url }, 150)).rejects.toThrow();
});

for (const [name, override] of [
  ["foreign origin", { url: "https://example.com/fixture/repo/runs/123" }],
  ["embedded credentials", { url: "https://fixture-user:fixture-password@github.com/fixture/repo/runs/123" }],
  ["query suffix", { url: `${expected.url}?x=1` }],
  ["hash suffix", { url: `${expected.url}#fragment` }],
  ["non-numeric run ID", { url: "https://github.com/fixture/repo/runs/abc" }],
  ["short commit", { headSha: "a".repeat(7) }],
  ["score below range", { score: 0 }],
  ["score above range", { score: 6 }],
] as const) {
  test(`rejects a malformed check reference: ${name}`, async ({ page }) => {
    // These must reject before navigation or DOM inspection.
    await expect(assertGitHubJourneyCheck(page, { ...expected, ...override }, 150))
      .rejects.toThrow("github_check_reference_mismatch");
  });
}

function taskStatus(status: string, hidden = false) {
  return `<div data-property-row="true"${hidden ? ' style="display:none"' : ""}>
    <span data-property-label="Status">Status</span><div data-property-value="true">
      <button aria-label="Change status (current: ${status})"><svg><title>${status}</title></svg><span>${status}</span></button>
    </div></div>`;
}

test("accepts visible Done status despite hidden controls and SVG title text", async ({ page }) => {
  await page.setContent(`<button style="display:none">Done</button>${taskStatus("Done", true)}${taskStatus("Done")}`);
  await expect(page.getByText("Done", { exact: true }).first()).toBeHidden();
  await assertGitHubJourneyTaskDone(page, 150);
});

test("rejects Done in the narrative when the task is still in progress", async ({ page }) => {
  await page.setContent(`<p>Done</p>${taskStatus("In Progress")}`);
  await expect(assertGitHubJourneyTaskDone(page, 150)).rejects.toThrow();
});

test("rejects hidden Done status when the visible status is in progress", async ({ page }) => {
  await page.setContent(`${taskStatus("Done", true)}${taskStatus("In Progress")}`);
  await expect(assertGitHubJourneyTaskDone(page, 150)).rejects.toThrow();
});

test("rejects a Done picker in an unrelated property", async ({ page }) => {
  await page.setContent(taskStatus("Done").replace('data-property-label="Status">Status', 'data-property-label="Assignee">Assignee'));
  await expect(assertGitHubJourneyTaskDone(page, 150)).rejects.toThrow();
});
