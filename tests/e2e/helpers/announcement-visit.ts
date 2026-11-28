import type { Page } from "@playwright/test";

export async function seedReturningAnnouncementVisit(page: Page) {
  await page.addInitScript(() => {
    const key = "paperclip.board-visit.v1:local-board";
    if (!localStorage.getItem(key)) localStorage.setItem(key, String(Date.now() - 31 * 60_000));
  });
}

export const CONNECTORS_ANNOUNCEMENT = {
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

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export async function serveConnectorsAnnouncement(page: Page, announcement: object = CONNECTORS_ANNOUNCEMENT) {
  await seedReturningAnnouncementVisit(page);
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
