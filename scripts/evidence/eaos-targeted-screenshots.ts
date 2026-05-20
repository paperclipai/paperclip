// LET-503 review round 2 — targeted evidence shots requested by the
// design reviewer:
//   - selected-node org graph with the right-sidebar populated
//   - 1440x720 builder Identity and Knowledge step with the new
//     disabled-reason + summary-invalid recovery actions visible
//   - missions list at 1440x720 to prove the new copy + the scroll
//     anchor falls cleanly on the first row
//
// Uses the same mock-API fixtures as the main runner, so the captures
// reflect the populated-customer surface that the reviewer will check.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readdir } from "node:fs/promises";
import {
  buildScreenshotApiRoutes,
  SCREENSHOT_COMPANY_ID,
  screenshotApiFallback,
} from "./eaos-screenshot-fixtures";

async function loadPlaywright(): Promise<typeof import("playwright")> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const storeRoot = resolve(__dirname, "..", "..", "node_modules", ".pnpm");
  const entries = await readdir(storeRoot);
  const match = entries.find((name) => name.startsWith("playwright@"));
  if (!match) throw new Error("playwright not installed");
  const entry = resolve(storeRoot, match, "node_modules/playwright/index.mjs");
  return (await import(pathToFileURL(entry).toString())) as typeof import("playwright");
}

interface Args {
  readonly base: string;
  readonly outDir: string;
}

function parseArgs(argv: readonly string[]): Args {
  let base = "http://localhost:5173";
  let outDir = "evidence/LET-503/screenshots/targeted";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") base = argv[++i] ?? base;
    else if (arg === "--out") outDir = argv[++i] ?? outDir;
  }
  return { base, outDir };
}

interface Capture {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly path: string;
  readonly waitFor: string;
  readonly setup?: (page: import("playwright").Page) => Promise<void>;
}

const CAPTURES: readonly Capture[] = [
  {
    id: "org-selected-node",
    width: 1440,
    height: 900,
    path: "/eaos/org",
    waitFor: '[data-testid="eaos-org-page"]',
    setup: async (page) => {
      // Wait for the org graph to mount, then click a known agent node.
      await page.waitForSelector(
        '[data-testid="eaos-org-node-00000000-0000-0000-0000-000000000a03"]',
        { timeout: 8_000 },
      );
      await page
        .locator('[data-testid="eaos-org-node-00000000-0000-0000-0000-000000000a03"]')
        .click({ force: true });
      await page.waitForSelector('[data-testid="eaos-org-details"]', { timeout: 4_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    id: "org-company-root-selected",
    width: 1440,
    height: 900,
    path: "/eaos/org",
    waitFor: '[data-testid="eaos-org-page"]',
    setup: async (page) => {
      await page.waitForSelector(
        '[data-testid="eaos-org-node-__eaos-org-company-root"]',
        { timeout: 8_000 },
      );
      await page
        .locator('[data-testid="eaos-org-node-__eaos-org-company-root"]')
        .click({ force: true });
      await page.waitForSelector(
        '[data-testid="eaos-org-details"][data-eaos-org-details-kind="company"]',
        { timeout: 4_000 },
      );
      await page.waitForTimeout(300);
    },
  },
  {
    id: "builder-identity-pristine-720",
    width: 1440,
    height: 720,
    path: "/eaos/agents/new",
    waitFor: '[data-testid="eaos-agent-builder-page"]',
    setup: async (page) => {
      await page.waitForSelector('[data-testid="eaos-agent-builder-panel-identity"]', {
        timeout: 6_000,
      });
      await page.waitForTimeout(300);
    },
  },
  {
    id: "builder-knowledge-recovery-720",
    width: 1440,
    height: 720,
    path: "/eaos/agents/new",
    waitFor: '[data-testid="eaos-agent-builder-page"]',
    setup: async (page) => {
      await page.waitForSelector('[data-testid="eaos-agent-builder-step-knowledge"]', {
        timeout: 6_000,
      });
      await page.locator('[data-testid="eaos-agent-builder-step-knowledge"]').click();
      await page.waitForSelector('[data-testid="eaos-agent-builder-go-identity"]', {
        timeout: 4_000,
      });
      await page.waitForTimeout(300);
    },
  },
  {
    id: "missions-list-720",
    width: 1440,
    height: 720,
    path: "/eaos/missions",
    waitFor: '[data-testid="eaos-missions-page"]',
    setup: async (page) => {
      await page.waitForSelector('[data-testid="eaos-missions-bucket-active"]', {
        timeout: 6_000,
      });
      // Make sure the scroll position starts at the top so the first
      // row in the board view is not clipped.
      await page.evaluate(() => {
        const scroller =
          document.querySelector('section[id="eaos-section-content"] > div') ??
          document.scrollingElement ??
          document.documentElement;
        if (scroller) (scroller as HTMLElement).scrollTop = 0;
      });
      await page.waitForTimeout(200);
    },
  },
  {
    id: "missions-list-scrolled-720",
    width: 1440,
    height: 720,
    path: "/eaos/missions",
    waitFor: '[data-testid="eaos-missions-page"]',
    setup: async (page) => {
      await page.waitForSelector('[data-testid="eaos-missions-bucket-active"]', {
        timeout: 6_000,
      });
      // Scroll halfway then to the bottom so reviewers can see the
      // overflow handling and the sticky chrome.
      await page.evaluate(() => {
        const scroller =
          document.querySelector('section[id="eaos-section-content"] > div') ??
          document.scrollingElement ??
          document.documentElement;
        if (scroller) {
          const max = (scroller as HTMLElement).scrollHeight;
          (scroller as HTMLElement).scrollTop = Math.floor(max * 0.6);
        }
      });
      await page.waitForTimeout(250);
    },
  },
];

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  process.chdir(resolve(__dirname, "..", ".."));

  const args = parseArgs(process.argv.slice(2));
  await ensureDir(args.outDir);

  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(
      (input: { theme: string; companyId: string }) => {
        try {
          window.localStorage.setItem("paperclip.theme", input.theme);
          window.localStorage.setItem("paperclip.selectedCompanyId", input.companyId);
        } catch {
          /* ignore */
        }
      },
      { theme: "light", companyId: SCREENSHOT_COMPANY_ID },
    );

    const routes = buildScreenshotApiRoutes({
      mode: "populated",
      viewerRole: "customer-member",
    });
    await context.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const match = routes.find((spec) => {
        if (spec.methodPattern && !spec.methodPattern.test(method)) return false;
        return spec.pathPattern.test(url.pathname);
      });
      const result = match
        ? typeof match.response === "function"
          ? match.response(url, method)
          : match.response
        : screenshotApiFallback(url);
      await route.fulfill({
        status: result.status,
        contentType: "application/json",
        body: JSON.stringify(result.body),
      });
    });

    const records: Array<{ id: string; file: string; ok: boolean; note?: string }> = [];
    for (const capture of CAPTURES) {
      const page = await context.newPage();
      const target = resolve(args.outDir, `${capture.id}.png`);
      await ensureDir(dirname(target));
      try {
        await page.setViewportSize({ width: capture.width, height: capture.height });
        await page.goto(new URL(capture.path, args.base).toString(), {
          waitUntil: "domcontentloaded",
        });
        await page.waitForSelector(capture.waitFor, { timeout: 12_000 });
        if (capture.setup) await capture.setup(page);
        await page.screenshot({ path: target, fullPage: false });
        records.push({ id: capture.id, file: target, ok: true });
      } catch (error) {
        // Still snap the page so the reviewer can see what went wrong.
        try {
          await page.screenshot({ path: target, fullPage: false });
        } catch {
          /* ignore */
        }
        records.push({
          id: capture.id,
          file: target,
          ok: false,
          note: (error as Error).message?.split("\n")[0] ?? "capture failed",
        });
      } finally {
        await page.close();
      }
    }

    const outDirAbs = resolve(args.outDir);
    const portable = records.map((r) => ({
      ...r,
      file: relative(outDirAbs, r.file) || r.file,
    }));
    const manifestPath = resolve(args.outDir, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schema: "eaos-targeted-screenshots/v1",
          generatedAt: new Date().toISOString(),
          base: args.base,
          viewer: "customer-member",
          mode: "populated",
          captures: portable,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // eslint-disable-next-line no-console
    console.log(
      `LET-503 targeted — wrote ${records.length} captures (ok=${records.filter((r) => r.ok).length}, failed=${records.filter((r) => !r.ok).length}) to ${args.outDir}`,
    );
    for (const r of records.filter((entry) => !entry.ok)) {
      // eslint-disable-next-line no-console
      console.log(`  - ${r.id}: ${r.note}`);
    }
  } finally {
    await browser.close();
  }
}

void main();
