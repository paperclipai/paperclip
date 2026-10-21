import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
test.setTimeout(60_000);

for (const hasPlan of [false, true]) {
  for (const entry of ["direct", "list"]) {
    test(`task reuses a full plan projection and fetches one for list-only snapshots (plan=${hasPlan}, entry=${entry})`, async ({ page, request }) => {
      const companyResponse = await request.post("/api/companies", { data: { name: `Plan startup ${Date.now()}` } });
      expect(companyResponse.ok()).toBe(true);
      const company = await companyResponse.json();
      const issueResponse = await request.post(`/api/companies/${company.id}/issues`, { data: { title: "Read a saved conversation", status: "backlog" } });
      expect(issueResponse.ok()).toBe(true);
      const issue = await issueResponse.json();
      const commentResponse = await request.post(`/api/issues/${issue.id}/comments`, { data: { body: "This saved reply must be readable without a redundant plan request." } });
      expect(commentResponse.ok()).toBe(true);
      if (hasPlan) {
        const planResponse = await request.put(`/api/issues/${issue.id}/documents/plan`, { data: { format: "markdown", title: "Saved plan", body: "# Follow the saved plan\n\nKeep the conversation stable." } });
        expect(planResponse.ok()).toBe(true);
      }
      let planRequests = 0;
      await page.route("**/api/issues/*/documents/plan", async (route) => {
        planRequests += 1;
        if (entry === "direct") await route.abort();
        else await route.continue();
      });
      if (entry === "list") {
        await page.goto(`/${company.issuePrefix}/issues`);
        await page.locator("[data-inbox-issue-link]", { hasText: "Read a saved conversation" }).first().click();
      } else {
        await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
      }
      const thread = page.getByTestId("task-chat-thread");
      await expect(thread.locator(':scope > [aria-busy="false"]')).toBeVisible({ timeout: 10_000 });
      await expect(thread.getByText("This saved reply must be readable without a redundant plan request.", { exact: true })).toBeVisible();
      if (hasPlan) await expect(thread.getByTestId("task-chat-plan-preview")).toBeVisible();
      expect(planRequests).toBe(entry === "direct" ? 0 : 1);
    });
  }
}

test("profiling records every gate when switching back to a fully cached task", async ({ page, request }) => {
  const companyResponse = await request.post("/api/companies", { data: { name: `Readiness switches ${Date.now()}` } });
  expect(companyResponse.ok()).toBe(true);
  const company = await companyResponse.json();
  const tasks = [];
  for (const title of ["First cached task", "Second cached task"]) {
    const response = await request.post(`/api/companies/${company.id}/issues`, { data: { title, status: "backlog" } });
    expect(response.ok()).toBe(true);
    tasks.push(await response.json());
  }
  for (const [index, task] of tasks.entries()) {
    const destination = tasks[1 - index];
    const response = await request.post(`/api/issues/${task.id}/comments`, {
      data: { body: `[Switch task](/${company.issuePrefix}/issues/${destination.identifier})` },
    });
    expect(response.ok()).toBe(true);
  }
  await page.addInitScript(() => { window.__PAPERCLIP_ISSUE_DETAIL_PROFILE__ = true; });
  await page.goto(`/${company.issuePrefix}/issues/${tasks[0].identifier}`);
  const ready = () => expect(page.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]')).toBeVisible();
  await ready();
  await page.getByRole("link", { name: new RegExp(`^Issue ${tasks[1].identifier}(?:[: ]|$)`) }).click({ timeout: 5_000 });
  await expect(page).toHaveURL(new RegExp(`${tasks[1].identifier}$`));
  await ready();
  await page.getByRole("link", { name: new RegExp(`^Issue ${tasks[0].identifier}(?:[: ]|$)`) }).click({ timeout: 5_000 });
  await expect(page).toHaveURL(new RegExp(`${tasks[0].identifier}$`));
  await ready();
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType("mark")
    .filter((entry) => entry.name.startsWith("issue-detail:gate:") && (entry as PerformanceMark).detail?.ready)
    .map((entry) => entry.name.slice("issue-detail:gate:".length))))
    .toEqual(expect.arrayContaining(["issue", "comments", "interactions", "attachments", "work-products", "activity", "linked-runs", "runtime", "plan", "transcripts", "history"]));
});
