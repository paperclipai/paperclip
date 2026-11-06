import { test, expect, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";

/**
 * N-17: a new user's first task view must stay usable while the in-app
 * announcement card is showing. The card is optional product news; it must not
 * sit on top of the task thread or the composer at ordinary laptop sizes.
 *
 * The announcement feed is remote, so this spec serves the live
 * `2026-09-14-connectors` announcement through the app's own announcement API.
 */

const CONNECTORS_ANNOUNCEMENT = {
  id: "2026-09-14-connectors",
  eyebrow: "Introducing Connectors",
  title: "Give your agents the access they need",
  description:
    "Connect Gmail, GitHub, Notion, and more. Choose which agents get access, which accounts they use, and which actions they can take.",
  image: {
    path: "assets/59dd6169b4f7a0e3af527801853abac554e80c59519f556c9d234385682a65ee.png",
    alt: "Paperclip agents with their own sets of connected apps.",
  },
  primaryAction: { kind: "route", label: "Explore connectors", path: "/apps" },
};

// 1x1 PNG so the card renders its image band at full height.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
] as const;

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text);
}

type Box = { x: number; y: number; width: number; height: number };

function overlapArea(a: Box, b: Box) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? Math.round(width * height) : 0;
}

async function box(locator: Locator, name: string): Promise<Box> {
  const value = await locator.boundingBox();
  expect(value, `${name} should have a layout box`).not.toBeNull();
  return value!;
}

async function serveConnectorsAnnouncement(page: Page, announcement: object = CONNECTORS_ANNOUNCEMENT) {
  await page.route("**/api/announcements/current", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(announcement) }),
  );
  await page.route(`**/api/announcements/${CONNECTORS_ANNOUNCEMENT.id}/image`, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG }),
  );
  await page.route(`**/api/announcements/${CONNECTORS_ANNOUNCEMENT.id}/dismiss`, (route) =>
    route.fulfill({ status: 204 }),
  );
}

async function firstTask(request: APIRequestContext, name: string) {
  const company = await json(await request.post("/api/companies", { data: { name: `${name} ${Date.now()}` } }));
  const lead = await json(
    await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: "Team Lead",
        role: "ceo",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "console.log('ok')"], env: { NODE_OPTIONS: "" } },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      },
    }),
  );
  const issue = await json(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Paperclip onboarding", status: "backlog", assigneeAgentId: lead.id },
    }),
  );
  return { company, issue };
}

test.describe("Announcement placement on a new company's first task", () => {
  test("the announcement does not cover the task thread or composer", async ({ page, request }, testInfo) => {
    const { company, issue } = await firstTask(request, "Announcement Placement");
    await serveConnectorsAnnouncement(page);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);

      const composer = page.getByTestId("task-chat-composer-dock");
      await expect(composer).toBeVisible({ timeout: 30_000 });
      const announcement = page.getByRole("complementary", { name: "Paperclip announcements" });
      await expect(announcement.getByRole("heading", { name: CONNECTORS_ANNOUNCEMENT.title })).toBeVisible({
        timeout: 15_000,
      });
      // Let the entrance animation settle before measuring.
      await page.waitForTimeout(500);

      const label = `${viewport.width}x${viewport.height}`;
      await page.screenshot({ path: testInfo.outputPath(`announcement-${label}.png`) });

      const card = await box(announcement, "announcement");
      const thread = await box(page.locator("#main-content"), "task thread");
      const composerBox = await box(composer, "composer");
      expect.soft(overlapArea(card, composerBox), `${label}: announcement overlaps composer`).toBe(0);
      expect.soft(overlapArea(card, thread), `${label}: announcement overlaps task thread`).toBe(0);
      // The card stays fully readable and dismissible.
      expect.soft(card.y + card.height, `${label}: announcement is clipped`).toBeLessThanOrEqual(viewport.height);
      await expect.soft(announcement.getByRole("button", { name: "Dismiss announcement" })).toBeInViewport();
      await expect.soft(announcement.getByRole("link", { name: "Explore connectors" })).toBeInViewport();

      // The account menu stays reachable while the card shows.
      const accountTrigger = page.getByRole("button", { name: "Open account menu" });
      const accountBox = await box(accountTrigger, "account menu trigger");
      expect.soft(overlapArea(card, accountBox), `${label}: announcement overlaps account menu`).toBe(0);
      await accountTrigger.click();
      await expect.soft(page.getByRole("dialog", { name: "Account" })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  });

  test("a long announcement docked in a narrow sidebar keeps navigation and the account menu usable", async ({ page, request }) => {
    const { company, issue } = await firstTask(request, "Announcement Long");
    const long = {
      ...CONNECTORS_ANNOUNCEMENT,
      title: "Give your agents the access they need to finish real work across every tool your team uses daily",
      description: "Connect Gmail, GitHub, Notion, and more. ".repeat(10).slice(0, 400).trim(),
    };
    await serveConnectorsAnnouncement(page, long);
    // The narrowest supported sidebar width on a short laptop window.
    await page.addInitScript(() => localStorage.setItem("paperclip.sidebar.width", "208"));
    const viewport = { width: 1280, height: 720 };
    await page.setViewportSize(viewport);
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);

    const announcement = page.getByRole("complementary", { name: "Paperclip announcements" });
    await expect(announcement.getByRole("heading", { name: long.title })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);

    const card = await box(announcement, "announcement");
    expect.soft(card.height, "docked card keeps at most half the window height").toBeLessThanOrEqual(viewport.height / 2 + 1);
    await expect.soft(page.getByLabel("Workspace navigation").getByRole("link", { name: "Tasks" })).toBeInViewport();
    const accountTrigger = page.getByRole("button", { name: "Open account menu" });
    await expect.soft(accountTrigger).toBeInViewport();
    expect.soft(overlapArea(card, await box(accountTrigger, "account menu trigger"))).toBe(0);
    // The card scrolls, so its actions stay reachable.
    const action = announcement.getByRole("link", { name: "Explore connectors" });
    await action.scrollIntoViewIfNeeded();
    await expect.soft(action).toBeInViewport();
    expect.soft(overlapArea(await box(action, "announcement action"), card)).toBeGreaterThan(0);
  });
});
