import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";

/**
 * E2E (N-13): the in-app announcement well ("Introducing Connectors" upsell)
 *
 * stays hidden while a new company's onboarding first task is open, so it
 * cannot cover the onboarding questions or the account menu in the user's
 * first session. Placement (never covering the account menu once shown) is
 * covered by announcement-placement.spec.ts.
 *
 * The public feed is mocked so the spec does not depend on what the live feed
 * is publishing; the card mirrors the real 2026-09-14-connectors entry.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ANNOUNCEMENT_ID = "e2e-n13-connectors";
const SETTLE_WAIT_MS = 4_500; // ANNOUNCEMENT_SETTLE_MS (3 s) plus slack.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function createCompany(board: APIRequestContext, name: string) {
  const res = await board.post(`${BASE_URL}/api/companies`, { data: { name: `${name}-${Date.now()}` } });
  if (!res.ok()) throw new Error(`POST /api/companies → ${res.status()}: ${await res.text()}`);
  const company = await res.json();
  // A company without agents lands on "Create your first agent"; add one so the normal shell renders.
  const agentRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
    data: { name: "Chief of staff", role: "ceo", adapterType: "process", adapterConfig: { command: "true" } },
  });
  if (!agentRes.ok()) throw new Error(`POST agents → ${agentRes.status()}: ${await agentRes.text()}`);
  return { id: company.id as string, prefix: (company.issuePrefix ?? company.prefix) as string };
}

async function createIssue(board: APIRequestContext, companyId: string, data: Record<string, unknown>) {
  const res = await board.post(`${BASE_URL}/api/companies/${companyId}/issues`, { data });
  if (!res.ok()) throw new Error(`POST issues → ${res.status()}: ${await res.text()}`);
  return res.json() as Promise<{ id: string; identifier: string; originKind: string | null }>;
}

async function mockAnnouncementFeed(page: Page) {
  await page.route("**/api/announcements/current", (route) => route.fulfill({ json: {
    id: ANNOUNCEMENT_ID,
    eyebrow: "Introducing Connectors",
    title: "Give your agents the access they need",
    description: "Connect Gmail, GitHub, Notion, and more. Choose which agents get access, which accounts they use, and which actions they can take.",
    image: { path: `assets/${"a".repeat(64)}.png`, alt: "Paperclip agents with their own sets of connected apps." },
    primaryAction: { kind: "route", label: "Explore connectors", path: "/apps" },
  } }));
  await page.route(`**/api/announcements/${ANNOUNCEMENT_ID}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: ONE_PIXEL_PNG }));
  await page.route(`**/api/announcements/${ANNOUNCEMENT_ID}/dismiss`, (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/workspace-preferences/me", (route) => route.fulfill({ json: {
    userId: "local-board", coordinatorWorkspaceEnabled: false, updatedAt: null,
  } }));
  await page.addInitScript(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.includes("announcement")) window.localStorage.removeItem(key);
    }
  });
}

test.describe("Announcement well (N-13)", () => {
  let board: APIRequestContext;
  const companyIds: string[] = [];

  test.beforeAll(async () => {
    board = await pwRequest.newContext({ baseURL: BASE_URL });
  });

  test.afterAll(async () => {
    for (const id of companyIds) await board.delete(`${BASE_URL}/api/companies/${id}`).catch(() => {});
    await board.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockAnnouncementFeed(page);
  });

  test("a brand-new company with its onboarding task open does not show the upsell", async ({ page }) => {
    const company = await createCompany(board, "E2E-N13-Onboarding");
    companyIds.push(company.id);
    const firstTask = await createIssue(board, company.id, {
      title: "Plan our launch", status: "todo", onboardingFirstTask: true,
    });
    expect(firstTask.originKind).toBe("onboarding_first_task");

    await page.goto(`/${company.prefix}/issues/${firstTask.identifier}`);
    await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
    await page.waitForTimeout(SETTLE_WAIT_MS);
    await page.screenshot({ path: test.info().outputPath("onboarding-task.png") });
    const well = page.getByRole("complementary", { name: "Paperclip announcements" });
    await expect(well).toHaveCount(0);

    // Positive control on the same page: once onboarding finishes, the same
    // mocked announcement renders without a reload. This proves the absence
    // above comes from the onboarding gate, not from a broken feed mock.
    const finish = await board.patch(`${BASE_URL}/api/issues/${firstTask.id}`, { data: { status: "done" } });
    if (!finish.ok()) throw new Error(`PATCH issue → ${finish.status()}: ${await finish.text()}`);
    await expect(well).toBeVisible({ timeout: 20_000 });
    await expect(well.getByRole("link", { name: "Explore connectors" })).toBeVisible();
  });
});
