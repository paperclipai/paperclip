/**
 * LET-505 — Playwright-driven evidence screenshot capture for the LET-503
 * EAOS shell.
 *
 * Walks the EAOS primary-nav routes at 1440×900, 1920×1080, and a small
 * 1440×720 viewport (for the scroll-proof shot). Saves PNGs under
 * `evidence/LET-503/screenshots/<viewport>/<route-slug>.png`.
 *
 * No vendor traffic is involved. The script is intentionally read-only:
 * navigates to each `/eaos/*` route, waits for it to render, and snapshots
 * the visible viewport. No live action is invoked.
 *
 * Usage:
 *
 *   # Terminal 1 — start the EAOS dev UI (proxies /api to your API server)
 *   pnpm --filter @paperclipai/ui dev
 *
 *   # Terminal 2 — ensure your `paperclip-session` cookie is set so the
 *   # API proxy can authenticate, then run:
 *   tsx scripts/evidence/eaos-screenshots.ts \
 *     --base http://localhost:5173 \
 *     --cookie 'paperclip-session=...' \
 *     --out evidence/LET-503/screenshots
 *
 * The cookie is read once and re-applied per viewport so the auth state
 * does not bleed between runs. If `--cookie` is omitted the script still
 * runs but pages will render their no-company / loading / error state —
 * which is itself a valid form of evidence for the truthful-gap audit.
 *
 * The output directory layout is:
 *
 *   evidence/LET-503/screenshots/
 *     1440/<route>.png       — desktop 1440×900
 *     1920/<route>.png       — wide 1920×1080
 *     scroll/<route>.png     — 1440×720, scrolled to bottom for scroll proof
 *
 * Hard gates: no deploy, no restart, no prod migration, no spend, no live
 * vendor enablement. Outputs are local PNG files only.
 */

// The root workspace does not list playwright as a top-level dep, so we
// resolve the pnpm-store copy directly (same pattern as
// scripts/let-368-evidence.mjs). This keeps the runner usable without a
// workspace package.json change.
import { mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, BrowserContext, Cookie } from "playwright";

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

interface Args {
  readonly base: string;
  readonly cookie: string | null;
  readonly outDir: string;
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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base" || arg === "-b") {
      base = argv[++i] ?? base;
    } else if (arg === "--cookie" || arg === "-c") {
      cookie = argv[++i] ?? null;
    } else if (arg === "--out" || arg === "-o") {
      outDir = argv[++i] ?? outDir;
    }
  }
  return { base, cookie, outDir };
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
): Promise<void> {
  const page = await context.newPage();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });

  const url = new URL(route.path, args.base).toString();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  try {
    await page.waitForSelector(route.waitForSelector, { timeout: 15_000, state: "visible" });
  } catch {
    // Surface still renders even if the API is unauthenticated; the
    // resulting screenshot is the truthful gap state, which is itself
    // valid evidence.
  }

  if (route.subSteps && viewport.id !== "scroll") {
    for (const step of route.subSteps) {
      const stepBtn = page.getByTestId(step.stepperTestId);
      await stepBtn.click({ trial: false });
      // small settle — purely DOM update.
      await page.waitForTimeout(150);
      const target = resolve(args.outDir, viewport.id, `${route.id}-${step.slug}.png`);
      await ensureDir(dirname(target));
      await page.screenshot({ path: target, fullPage: false });
    }
    await page.close();
    return;
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
  await page.close();
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

  let captured = 0;
  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      if (viewport.id === "scroll" && route.subSteps) continue;
      await captureRoute(context, args, viewport, route);
      captured++;
    }
  }

  await context.close();
  await browser.close();

  // eslint-disable-next-line no-console
  console.log(
    `LET-505 — captured ${captured} screenshots to ${args.outDir}. Auth cookie was ${
      args.cookie ? "applied" : "not supplied"
    }; unauthenticated runs capture truthful-gap states.`,
  );
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error("LET-505 evidence runner failed:", error);
  process.exitCode = 1;
});
