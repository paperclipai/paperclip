import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// The tenant UI and task database are real. Cloud is an external dependency:
// simulate its entry endpoint and independent session states at the HTTP edge.
for (const cloudOrigin of ["https://my.paperclip.app", "https://my-staging.paperclip.app"]) {
  for (const entry of ["auth", "task"] as const) {
    test(`Cloud recovery preserves the task (${cloudOrigin}, ${entry})`, async ({ page, request, baseURL }, testInfo) => {
      const companyResponse = await request.post("/api/companies", { data: { name: `Cloud auth ${randomUUID()}` } });
      expect(companyResponse.ok()).toBe(true);
      const company = await companyResponse.json();
      const issueResponse = await request.post(`/api/companies/${company.id}/issues`, {
        data: { title: "Return here after Cloud sign-in", status: "backlog" },
      });
      expect(issueResponse.ok()).toBe(true);
      const issue = await issueResponse.json();
      const target = `/${company.issuePrefix}/issues/${issue.identifier}?view=activity#recovered`;
      let authenticated = false;
      let handoffs = 0;
      let formWasRendered = false;
      await page.exposeFunction("reportInstanceLoginForm", () => { formWasRendered = true; });
      await page.addInitScript(() => {
        new MutationObserver(() => {
          if (document.querySelector('input[autocomplete="current-password"]')) {
            void (window as unknown as { reportInstanceLoginForm: () => Promise<void> }).reportInstanceLoginForm();
          }
        }).observe(document, { childList: true, subtree: true });
      });
      await page.route("**/api/health", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: {
          ...await response.json(), deploymentMode: "authenticated", bootstrapStatus: "ready",
          cloud: { managed: true, managedBy: "paperclip-cloud", cloudBaseUrl: cloudOrigin, stackSlug: "test-workspace" },
        } });
      });
      await page.route("**/api/auth/get-session", (route) => route.fulfill(authenticated ? {
        json: { session: { id: "test-session", userId: "local-board" }, user: { id: "local-board", email: "test@example.test", name: "Test user", image: null }, sentryDsn: null },
      } : { status: 401, json: { error: "Board authentication required" } }));
      await page.route(`${cloudOrigin}/v1/stacks/test-workspace/entry-redirect?**`, async (route) => {
        handoffs++;
        expect(new URL(route.request().url()).searchParams.get("returnTo")).toBe(target);
        authenticated = true;
        await route.fulfill({ status: 302, headers: { Location: `${baseURL}${target}` } });
      });
      await page.goto(entry === "auth" ? `/auth?next=${encodeURIComponent(target)}` : target);
      await expect(page.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();
      expect(page.url()).toBe(`${baseURL}${target}`);
      expect(handoffs).toBe(1);
      expect(formWasRendered).toBe(false);
      await page.screenshot({ path: testInfo.outputPath("cloud-session-recovered.png") });
      await page.reload();
      await expect(page.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();
      expect(handoffs).toBe(1);
      expect(formWasRendered).toBe(false);
    });
  }
}

test("self-hosted auth still shows the instance sign-in form", async ({ page }) => {
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ status: 401, json: { error: "Board authentication required" } }));
  await page.goto("/auth");
  await expect(page.getByRole("heading", { name: "Sign in to Paperclip", exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
});
