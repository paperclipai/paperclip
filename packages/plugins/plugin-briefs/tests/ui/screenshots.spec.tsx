/**
 * Renders the Briefing page UI with a curated fixture set and writes
 * desktop + mobile + empty-state PNG snapshots into
 * `docs/pr-screenshots/pap-9963/`.
 *
 * Skipped by default — set `BRIEFS_CAPTURE_SCREENSHOTS=1` to opt in.
 *
 * Mounts the real `<BriefingPage>` component (the same React tree the host
 * renders) so the captured PNGs reflect the live dashboard composition instead
 * of a hand-rolled approximation. The Paperclip plugin SDK
 * is mocked so `usePluginData("page", …)` returns the gallery fixture.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ReactNode } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { BriefCard } from "../../src/contracts.js";
import { gallery } from "./fixtures.js";

type PageData = {
  cards: BriefCard[];
  fetchedAt: string;
};

let mockPageData: PageData = {
  cards: [],
  fetchedAt: "2026-05-22T10:00:00.000Z",
};

vi.mock("@paperclipai/plugin-sdk/ui", () => {
  return {
    useHostNavigation: () => ({
      resolveHref: (to: string) => to,
      navigate: () => {},
      linkProps: (to: string) => ({ href: to, onClick: () => {} }),
    }),
    usePluginAction: () => vi.fn(async () => ({ ok: true })),
    usePluginData: (key: string) => {
      if (key === "page") {
        return { data: mockPageData, loading: false, error: null, refresh: () => {} };
      }
      return { data: null, loading: false, error: null, refresh: () => {} };
    },
    usePluginToast: () => vi.fn(),
    IssueRow: ({ issue, trailingMeta }: { issue: { identifier?: string | null; title: string }; trailingMeta?: ReactNode }) => (
      <a data-plugin-issue-row={issue.identifier ?? ""} href={`/issues/${issue.identifier ?? ""}`}>{issue.identifier} {issue.title} {trailingMeta}</a>
    ),
    useHostLocation: () => ({ pathname: "/PAP/briefs", search: "", hash: "" }),
    usePluginStream: () => ({ events: [], lastEvent: null, connecting: false, connected: false, error: null, close: () => {} }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { BriefingPage } from "../../src/ui/app.js";

const ENABLED = process.env.BRIEFS_CAPTURE_SCREENSHOTS === "1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../..");
const outDir = path.resolve(repoRoot, "docs/pr-screenshots/pap-9963");

const desktopWidth = 1440;
const mobileWidth = 390;

const hostContext = {
  companyId: "company-1",
  companyPrefix: "PAP",
  projectId: null,
  entityId: null,
  entityType: null,
  userId: "user-1",
} as const;

function renderPageHtml({ cards, viewportWidth }: { cards: BriefCard[]; viewportWidth: number }): string {
  mockPageData = { cards, fetchedAt: "2026-05-22T10:00:00.000Z" };
  const isMobile = viewportWidth < 700;
  const inlineCss = `
    :root {
      --background: oklch(0.145 0 0);
      --foreground: oklch(0.985 0 0);
      --card: oklch(0.205 0 0);
      --border: oklch(0.269 0 0);
      --muted-foreground: oklch(0.708 0 0);
      --primary: oklch(0.985 0 0);
      --primary-foreground: oklch(0.205 0 0);
      --secondary: oklch(0.269 0 0);
      --accent: oklch(0.269 0 0);
    }
    html, body { background: var(--background); color: var(--foreground); margin: 0; min-height: 100vh; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    a { color: inherit; }
    @media (max-width: 700px) {
      [data-briefs-page-header] > [data-briefs-page-meta] { flex-basis: 100% !important; order: 2 !important; }
    }
  `;
  const body = renderToStaticMarkup(<BriefingPage context={hostContext as never} />);
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Briefing — ${isMobile ? "mobile" : "desktop"}</title>
      <style>${inlineCss}</style>
    </head>
    <body>${body}</body>
  </html>`;
}

describe.skipIf(!ENABLED)("Briefs screenshots", () => {
  let browser: import("playwright").Browser | null = null;

  async function getBrowser() {
    if (browser) return browser;
    const playwright = await import("playwright");
    browser = await playwright.chromium.launch({ headless: true });
    return browser;
  }

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it("captures desktop, mobile, and empty-state Briefing snapshots", async () => {
    await fs.mkdir(outDir, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(__dirname, ".tmp-briefs-"));
    const cards = gallery();

    const desktopHtml = renderPageHtml({ cards, viewportWidth: desktopWidth });
    const mobileHtml = renderPageHtml({ cards, viewportWidth: mobileWidth });
    const emptyHtml = renderPageHtml({ cards: [], viewportWidth: desktopWidth });

    const desktopFile = path.join(tmpDir, "briefing-desktop.html");
    const mobileFile = path.join(tmpDir, "briefing-mobile.html");
    const emptyFile = path.join(tmpDir, "briefing-empty.html");
    await fs.writeFile(desktopFile, desktopHtml);
    await fs.writeFile(mobileFile, mobileHtml);
    await fs.writeFile(emptyFile, emptyHtml);

    const browser = await getBrowser();

    await snap(browser, desktopFile, { width: desktopWidth, height: 900 }, path.join(outDir, "briefing-desktop.png"));
    await snap(browser, mobileFile, { width: mobileWidth, height: 844 }, path.join(outDir, "briefing-mobile.png"));
    await snap(browser, emptyFile, { width: desktopWidth, height: 700 }, path.join(outDir, "briefing-empty.png"));

    for (const name of ["briefing-desktop.png", "briefing-mobile.png", "briefing-empty.png"]) {
      const stats = await fs.stat(path.join(outDir, name));
      expect(stats.size).toBeGreaterThan(1024);
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 60_000);
});

async function snap(browser: import("playwright").Browser, htmlPath: string, viewport: { width: number; height: number }, out: string): Promise<void> {
  const context = await browser.newContext({ viewport, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: out, fullPage: true });
  await context.close();
}
