/**
 * LET-505 — Playwright-driven evidence screenshot capture for the LET-503
 * EAOS shell.
 *
 * Walks the EAOS primary-nav routes at 1440×900, 1920×1080, and a small
 * 1440×720 viewport (for the scroll-proof shot). Saves PNGs under
 * `evidence/LET-503/screenshots/<viewport>/<route-slug>.png` and writes a
 * `manifest.json` describing per-route capture status (`anchor-hit`,
 * `truthful-gap`, etc.) so the reviewer can tell at a glance whether each
 * screenshot is the authenticated surface or the unauthenticated empty
 * state.
 *
 * No vendor traffic is involved. The script is intentionally read-only:
 * navigates to each `/eaos/*` route, waits for it to render, and snapshots
 * the visible viewport. No live action is invoked.
 *
 * Usage (repo-available command — no global `tsx` required):
 *
 *   # Terminal 1 — start the EAOS dev UI (proxies /api to your API server)
 *   pnpm --filter @paperclipai/ui dev
 *
 *   # Terminal 2 — run the runner using the tsx copy that ships with the
 *   # paperclip CLI workspace (the workspace root does not list tsx as a
 *   # top-level devDep). The default `--mock-api` flag intercepts every
 *   # `/api/*` request with the canned empty-state fixtures in
 *   # `scripts/evidence/eaos-screenshot-fixtures.ts`, which lets the EAOS
 *   # product shell render its real React tree under `deploymentMode =
 *   # local_trusted` without needing a session cookie or a second API
 *   # server. The fixtures are intentionally empty/skeleton so no
 *   # fake counts, no fake activity, no fake metrics leak into evidence:
 *   node cli/node_modules/.bin/tsx scripts/evidence/eaos-screenshots.ts \
 *     --base http://localhost:5173 \
 *     --theme light \
 *     --mock-api \
 *     --out evidence/LET-503/screenshots
 *
 *   # Disable mocks to capture the real backend state — pages will render
 *   # whatever the proxied API at /api/* returns (login wall, no-company
 *   # page, or authenticated surface depending on the running instance):
 *   node cli/node_modules/.bin/tsx scripts/evidence/eaos-screenshots.ts \
 *     --base http://localhost:5173 \
 *     --no-mock-api \
 *     --cookie 'paperclip-session=...' \
 *     --theme light \
 *     --out evidence/LET-503/screenshots
 *
 * The cookie is read once and re-applied per viewport so the auth state
 * does not bleed between runs. If `--cookie` is omitted and `--mock-api`
 * is disabled, the script still completes successfully: pages render
 * their no-company / loading / error state and each shot is tagged
 * `truthful-gap` in the manifest.
 *
 * `--theme light|dark` (default `light`) writes `paperclip.theme` into
 * `localStorage` via an init script before the React app mounts, so the
 * captured surfaces match the LET-502 light-first design contract even
 * when the global `ui/index.html` fallback would otherwise pick dark.
 *
 * The output directory layout is:
 *
 *   evidence/LET-503/screenshots/
 *     1440/<route>.png       — desktop 1440×900
 *     1920/<route>.png       — wide 1920×1080
 *     scroll/<route>.png     — 1440×720, scrolled to bottom for scroll proof
 *     manifest.json          — per-route capture status (anchor-hit/gap)
 *
 * Hard gates: no deploy, no restart, no prod migration, no spend, no live
 * vendor enablement. Outputs are local PNG files only.
 */

// The root workspace does not list playwright as a top-level dep, so we
// resolve the pnpm-store copy directly (same pattern as
// scripts/let-368-evidence.mjs). This keeps the runner usable without a
// workspace package.json change.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, BrowserContext, Cookie } from "playwright";
import {
  SCREENSHOT_API_ROUTES,
  SCREENSHOT_COMPANY_ID,
  screenshotApiFallback,
} from "./eaos-screenshot-fixtures";

async function loadPlaywright(): Promise<typeof import("playwright")> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const storeRoot = resolve(__dirname, "..", "..", "node_modules", ".pnpm");
  const entries = await readdir(storeRoot);
  const match = entries.find((name) => name.startsWith("playwright@"));
  if (!match) {
    throw new Error(
      `playwright not found in ${storeRoot} — install it once via 'pnpm add -w -D playwright' or rely on a workspace that already pulls it transitively.`,
    );
  }
  const entry = resolve(storeRoot, match, "node_modules/playwright/index.mjs");
  return (await import(pathToFileURL(entry).toString())) as typeof import("playwright");
}

type ThemeChoice = "light" | "dark";

interface Args {
  readonly base: string;
  readonly cookie: string | null;
  readonly outDir: string;
  readonly theme: ThemeChoice;
  readonly anchorTimeoutMs: number;
  readonly mockApi: boolean;
}

interface CaptureRecord {
  readonly viewport: ViewportSpec["id"];
  readonly route: string;
  readonly path: string;
  readonly file: string;
  readonly status: "anchor-hit" | "truthful-gap" | "error";
  readonly subStep?: string;
  readonly note?: string;
}

interface RouteSpec {
  readonly id: string;
  readonly path: string;
  readonly waitForSelector: string;
  // For multi-step surfaces — drive the stepper before capturing each step.
  readonly subSteps?: ReadonlyArray<{
    readonly slug: string;
    readonly stepperTestId: string;
  }>;
}

interface ViewportSpec {
  readonly id: "1440" | "1920" | "scroll";
  readonly width: number;
  readonly height: number;
  readonly scrollToBottom: boolean;
}

const VIEWPORTS: readonly ViewportSpec[] = [
  { id: "1440", width: 1440, height: 900, scrollToBottom: false },
  { id: "1920", width: 1920, height: 1080, scrollToBottom: false },
  { id: "scroll", width: 1440, height: 720, scrollToBottom: true },
];

const ROUTES: readonly RouteSpec[] = [
  {
    id: "eaos-dashboard",
    path: "/eaos",
    waitForSelector: '[data-testid="eaos-command-center-landing"]',
  },
  {
    id: "eaos-missions",
    path: "/eaos/missions",
    waitForSelector: '[data-testid="eaos-missions-page"]',
  },
  {
    id: "eaos-agents",
    path: "/eaos/agents",
    waitForSelector: '[data-testid="eaos-agents-page"]',
  },
  {
    id: "eaos-agents-new",
    path: "/eaos/agents/new",
    waitForSelector: '[data-testid="eaos-agent-builder-page"]',
    subSteps: [
      { slug: "step-1-identity", stepperTestId: "eaos-agent-builder-step-identity" },
      { slug: "step-2-model", stepperTestId: "eaos-agent-builder-step-model" },
      { slug: "step-3-invocations", stepperTestId: "eaos-agent-builder-step-invocations" },
      { slug: "step-4-tools", stepperTestId: "eaos-agent-builder-step-tools" },
      { slug: "step-5-skills", stepperTestId: "eaos-agent-builder-step-skills" },
      { slug: "step-6-knowledge", stepperTestId: "eaos-agent-builder-step-knowledge" },
    ],
  },
  {
    id: "eaos-org",
    path: "/eaos/org",
    waitForSelector: '[data-testid="eaos-org-page"]',
  },
  {
    id: "eaos-projects",
    path: "/eaos/projects",
    waitForSelector: '[data-eaos-zone-id="projects"], [data-testid^="eaos-projects-"]',
  },
  {
    id: "eaos-runs",
    path: "/eaos/runs",
    waitForSelector: '[data-eaos-zone-id="runs"], [data-testid^="eaos-runs-"]',
  },
  {
    id: "eaos-approvals",
    path: "/eaos/approvals",
    waitForSelector: '[data-eaos-zone-id="approvals"], [data-testid^="eaos-approvals-"]',
  },
  {
    id: "eaos-knowledge",
    path: "/eaos/knowledge",
    waitForSelector: '[data-eaos-zone-id="knowledge"], [data-testid^="eaos-knowledge-"]',
  },
  {
    id: "eaos-blueprints",
    path: "/eaos/blueprints",
    waitForSelector: '[data-testid^="eaos-blueprints-"]',
  },
  {
    id: "eaos-admin",
    path: "/eaos/admin",
    waitForSelector: '[data-eaos-zone-id="admin"], [data-testid^="eaos-admin-"]',
  },
];

function parseArgs(argv: readonly string[]): Args {
  let base = "http://localhost:5173";
  let cookie: string | null = null;
  let outDir = "evidence/LET-503/screenshots";
  let theme: ThemeChoice = "light";
  let anchorTimeoutMs = 8_000;
  let mockApi = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base" || arg === "-b") {
      base = argv[++i] ?? base;
    } else if (arg === "--cookie" || arg === "-c") {
      cookie = argv[++i] ?? null;
    } else if (arg === "--out" || arg === "-o") {
      outDir = argv[++i] ?? outDir;
    } else if (arg === "--theme" || arg === "-t") {
      const next = argv[++i];
      if (next === "light" || next === "dark") theme = next;
    } else if (arg === "--anchor-timeout") {
      const next = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(next) && next > 0) anchorTimeoutMs = next;
    } else if (arg === "--mock-api") {
      mockApi = true;
    } else if (arg === "--no-mock-api") {
      mockApi = false;
    }
  }
  return { base, cookie, outDir, theme, anchorTimeoutMs, mockApi };
}

function cookieToPlaywright(raw: string, baseUrl: string): Cookie[] {
  const url = new URL(baseUrl);
  return raw
    .split(/;\s*/)
    .filter((part) => part.includes("="))
    .map((part) => {
      const [name, ...rest] = part.split("=");
      return {
        name: name.trim(),
        value: rest.join("=").trim(),
        domain: url.hostname,
        path: "/",
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax" as const,
      };
    });
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function captureRoute(
  context: BrowserContext,
  args: Args,
  viewport: ViewportSpec,
  route: RouteSpec,
): Promise<CaptureRecord[]> {
  const records: CaptureRecord[] = [];
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const url = new URL(route.path, args.base).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    let anchorHit = false;
    try {
      await page.waitForSelector(route.waitForSelector, {
        timeout: args.anchorTimeoutMs,
        state: "visible",
      });
      anchorHit = true;
    } catch {
      // Truthful-gap path: the surface still renders (empty / loading /
      // unauthenticated state), and that PNG is recorded with status
      // `truthful-gap`. We do NOT throw — every viewport must produce a
      // file so the manifest is complete.
    }

    // Substeps are stepper-driven and only meaningful when the anchor
    // rendered. If it did not, we record one truthful-gap shot per route
    // for this viewport and skip clicking buttons that may not exist.
    if (route.subSteps && viewport.id !== "scroll" && anchorHit) {
      for (const step of route.subSteps) {
        const stepBtn = page.getByTestId(step.stepperTestId);
        const target = resolve(args.outDir, viewport.id, `${route.id}-${step.slug}.png`);
        await ensureDir(dirname(target));
        try {
          await stepBtn.waitFor({ state: "visible", timeout: 3_000 });
          await stepBtn.click({ trial: false });
          await page.waitForTimeout(150);
          await page.screenshot({ path: target, fullPage: false });
          records.push({
            viewport: viewport.id,
            route: route.id,
            path: route.path,
            file: target,
            status: "anchor-hit",
            subStep: step.slug,
          });
        } catch (error) {
          // Stepper button missing — capture whatever is on screen for
          // this sub-step slot so the reviewer can see the gap.
          await page.screenshot({ path: target, fullPage: false });
          records.push({
            viewport: viewport.id,
            route: route.id,
            path: route.path,
            file: target,
            status: "truthful-gap",
            subStep: step.slug,
            note: `stepper button ${step.stepperTestId} not visible: ${(error as Error).message?.split("\n")[0] ?? "unknown"}`,
          });
        }
      }
      return records;
    }

    if (viewport.scrollToBottom) {
      await page.evaluate(() => {
        const scroller =
          document.querySelector('section[id="eaos-section-content"] > div') ??
          document.scrollingElement ??
          document.documentElement;
        if (scroller) (scroller as HTMLElement).scrollTop = (scroller as HTMLElement).scrollHeight;
      });
      await page.waitForTimeout(200);
    }

    const target = resolve(args.outDir, viewport.id, `${route.id}.png`);
    await ensureDir(dirname(target));
    await page.screenshot({ path: target, fullPage: false });
    records.push({
      viewport: viewport.id,
      route: route.id,
      path: route.path,
      file: target,
      status: anchorHit ? "anchor-hit" : "truthful-gap",
      note: anchorHit
        ? undefined
        : `anchor selector "${route.waitForSelector}" not visible within ${args.anchorTimeoutMs}ms; captured empty/error state`,
    });
    return records;
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  process.chdir(resolve(__dirname, "..", ".."));

  const args = parseArgs(process.argv.slice(2));
  await ensureDir(args.outDir);

  const playwright = await loadPlaywright();
  const browser: Browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  if (args.cookie) {
    await context.addCookies(cookieToPlaywright(args.cookie, args.base));
  }

  // Pin the LET-502 light-first theme (or dark, if explicitly requested)
  // and pre-seed the selected-company id before the React app mounts.
  // The seed lets CompanyContext skip the auto-bootstrap fetch race so
  // the EAOS pages can render their data-scoped chrome immediately.
  // addInitScript fires on every navigation in this context.
  await context.addInitScript(
    (input: { theme: string; companyId: string }) => {
      try {
        window.localStorage.setItem("paperclip.theme", input.theme);
        window.localStorage.setItem("paperclip.selectedCompanyId", input.companyId);
      } catch {
        /* localStorage unavailable in some contexts — ignore. */
      }
    },
    { theme: args.theme, companyId: SCREENSHOT_COMPANY_ID },
  );

  // --mock-api intercepts every /api/* request with the canned empty-
  // state fixtures so the EAOS React shell can render its real chrome
  // without a session cookie or a second backend instance. The fixtures
  // force `deploymentMode = local_trusted` (bypassing CloudAccessGate),
  // surface one generic demo company, and return [] for every list
  // endpoint — so the captured PNGs show authentic empty states without
  // any fake counts/metrics/activity leaking in.
  if (args.mockApi) {
    // Match only URLs whose path begins with `/api/`. A plain glob like
    // `**/api/**` also catches Vite source modules under `/src/api/...`
    // and breaks the React app load — anchor the match with a RegExp.
    await context.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const match = SCREENSHOT_API_ROUTES.find((spec) => {
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
  }

  const records: CaptureRecord[] = [];
  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      if (viewport.id === "scroll" && route.subSteps) continue;
      try {
        const routeRecords = await captureRoute(context, args, viewport, route);
        records.push(...routeRecords);
      } catch (error) {
        records.push({
          viewport: viewport.id,
          route: route.id,
          path: route.path,
          file: resolve(args.outDir, viewport.id, `${route.id}.png`),
          status: "error",
          note: (error as Error).message?.split("\n")[0] ?? "capture threw",
        });
      }
    }
  }

  await context.close();
  await browser.close();

  const outDirAbs = resolve(args.outDir);
  const portableRecords = records.map((record) => ({
    ...record,
    file: relative(outDirAbs, record.file) || record.file,
  }));
  const manifest = {
    schema: "eaos-screenshots/v1",
    generatedAt: new Date().toISOString(),
    base: args.base,
    theme: args.theme,
    cookieApplied: Boolean(args.cookie),
    mockApi: args.mockApi,
    seededCompanyId: args.mockApi ? SCREENSHOT_COMPANY_ID : null,
    anchorTimeoutMs: args.anchorTimeoutMs,
    captures: portableRecords,
  };
  const manifestPath = resolve(args.outDir, "manifest.json");
  await ensureDir(dirname(manifestPath));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const counts = records.reduce(
    (acc, record) => {
      acc[record.status] = (acc[record.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<CaptureRecord["status"], number>,
  );

  // eslint-disable-next-line no-console
  console.log(
    `LET-505 — wrote ${records.length} captures to ${args.outDir} (anchor-hit=${
      counts["anchor-hit"] ?? 0
    }, truthful-gap=${counts["truthful-gap"] ?? 0}, error=${counts.error ?? 0}). Theme=${
      args.theme
    }; cookie ${args.cookie ? "applied" : "not supplied"}; mockApi=${args.mockApi}. Manifest: ${manifestPath}`,
  );
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error("LET-505 evidence runner failed:", error);
  process.exitCode = 1;
});
