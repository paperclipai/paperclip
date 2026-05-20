// LET-503 — Customer-mode string-leak audit.
//
// Opens each primary `/eaos/*` route in a headless Chromium browser with
// the screenshot mock-API fixtures + viewerRole = customer-member, then
// scrapes the rendered DOM (innerText) and asserts none of the forbidden
// implementation/operator strings appear. Designed to be a fast
// reviewer-facing sanity check that complements the unit-test grep
// assertions and the screenshot evidence package.

import { readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildScreenshotApiRoutes,
  SCREENSHOT_COMPANY_ID,
  screenshotApiFallback,
} from "./eaos-screenshot-fixtures";

const FORBIDDEN_NEEDLES: ReadonlyArray<string> = [
  // Operator escape hatches.
  "Kernel/Admin",
  "Kernel / Admin",
  "Open in admin",
  "Open in Admin",
  "Open in kernel",
  "Open in Kernel",
  "Legacy kernel",
  "Decide in kernel",
  "Decide in admin",
  // Truth-posture jargon.
  "BACKEND-BACKED",
  "BACKEND-DERIVED",
  "FRESHNESS · UNKNOWN",
  "Backend status:",
  "Backend status is",
  // Raw model/field identifiers.
  "issue.assigneeAgentId",
  "issue.assigneeUserId",
  "issue.executionAgentNameKey",
  // Raw adapter / activity enums in customer surfaces.
  "CLAUDE_LOCAL",
  "TEST_COMPLETED",
  "COMMENT_POSTED",
  "DOCUMENT_UPDATED",
  "BLOCKED_ON_DEPENDENCY",
  "pending_approval",
  // Debug / runtime jargon that customer-mode rails should never expose.
  "adapter_managed",
  "operator_branch",
  "adapterConfig",
  "runtimeConfig",
  "executionWorkspace",
  "Stage participant",
  "Latest run id",
  "executionRunId",
];

interface Route {
  readonly id: string;
  readonly path: string;
  readonly waitForSelector: string;
}

const ROUTES: readonly Route[] = [
  { id: "eaos-dashboard", path: "/eaos", waitForSelector: '[data-testid="eaos-command-center-landing"]' },
  { id: "eaos-missions", path: "/eaos/missions", waitForSelector: '[data-testid="eaos-missions-page"]' },
  { id: "eaos-agents", path: "/eaos/agents", waitForSelector: '[data-testid="eaos-agents-page"]' },
  { id: "eaos-agents-new", path: "/eaos/agents/new", waitForSelector: '[data-testid="eaos-agent-builder-page"]' },
  { id: "eaos-org", path: "/eaos/org", waitForSelector: '[data-testid="eaos-org-page"]' },
  { id: "eaos-projects", path: "/eaos/projects", waitForSelector: '[data-eaos-zone-id="projects"], [data-testid^="eaos-projects-"]' },
  { id: "eaos-runs", path: "/eaos/runs", waitForSelector: '[data-testid="eaos-runs-page"]' },
  { id: "eaos-approvals", path: "/eaos/approvals", waitForSelector: '[data-testid="eaos-approvals-page"]' },
  { id: "eaos-knowledge", path: "/eaos/knowledge", waitForSelector: '[data-eaos-zone-id="knowledge"], [data-testid^="eaos-knowledge-"]' },
  // LET-503 review round 2: extend audit to Blueprints + mission detail
  // so any customer-visible operator/runtime jargon on those surfaces
  // also fails the gate. The Admin route is explicitly excluded for
  // customer-mode because the primary nav now hides it for non-operator
  // viewers; the runner asserts the nav-link itself is missing instead.
  { id: "eaos-blueprints", path: "/eaos/blueprints", waitForSelector: '[data-testid^="eaos-blueprints-"]' },
  {
    id: "eaos-mission-detail",
    // Anchor on the populated-fixture identifier so the page resolves a
    // real mission rather than falling back to the not-found state.
    path: "/eaos/missions/ACME-104",
    waitForSelector:
      '[data-eaos-zone-id="missions"], [data-testid^="eaos-mission-"], [data-testid="eaos-missions-page"]',
  },
];

async function loadPlaywright(): Promise<typeof import("playwright")> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const storeRoot = resolve(__dirname, "..", "..", "node_modules", ".pnpm");
  const entries = await readdir(storeRoot);
  const match = entries.find((name) => name.startsWith("playwright@"));
  if (!match) throw new Error("playwright not installed in store");
  const entry = resolve(storeRoot, match, "node_modules/playwright/index.mjs");
  return (await import(pathToFileURL(entry).toString())) as typeof import("playwright");
}

interface Finding {
  readonly route: string;
  readonly needle: string;
  readonly snippet: string;
}

async function run(): Promise<void> {
  const base = process.argv.includes("--base")
    ? process.argv[process.argv.indexOf("--base") + 1]!
    : "http://localhost:5173";
  const outPath = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]!
    : "evidence/LET-503/customer-string-audit.json";

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const routes = buildScreenshotApiRoutes({ mode: "populated", viewerRole: "customer-member" });
    await context.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      for (const spec of routes) {
        if (spec.methodPattern && !spec.methodPattern.test(request.method())) continue;
        if (!spec.pathPattern.test(url.pathname)) continue;
        const response = typeof spec.response === "function"
          ? spec.response(url, request.method())
          : spec.response;
        await route.fulfill({
          status: response.status,
          contentType: "application/json",
          body: JSON.stringify(response.body),
        });
        return;
      }
      const fallback = screenshotApiFallback(url);
      await route.fulfill({
        status: fallback.status,
        contentType: "application/json",
        body: JSON.stringify(fallback.body),
      });
    });

    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("paperclip.theme", "light");
        window.localStorage.setItem("paperclip.selectedCompanyId", "00000000-0000-0000-0000-000000000eaa");
      } catch {
        /* ignore */
      }
    });

    const findings: Finding[] = [];
    const summary: Array<{ route: string; ok: boolean; bytes: number }> = [];
    // Track once-per-run: customer-mode primary nav must not surface the
    // Admin operator surface. We assert against the first successfully
    // rendered route (dashboard) so the chrome has been mounted.
    let adminNavCheckedAt: string | null = null;
    let adminNavLinkSeen = false;

    for (const route of ROUTES) {
      const page = await context.newPage();
      let anchorHit = false;
      try {
        await page.goto(`${base}${route.path}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
        try {
          await page.waitForSelector(route.waitForSelector, { timeout: 10_000, state: "visible" });
          anchorHit = true;
        } catch {
          // Anchor missed — capture body text anyway so we still grep it.
        }
        // Wait for React Query results + animations to settle.
        await page.waitForTimeout(1500);
        const text = await page.evaluate(() => {
          const html = document.documentElement.outerHTML;
          const tc = document.body?.textContent ?? "";
          return `${tc}\n---\n${html}`;
        });
        summary.push({ route: route.id, ok: anchorHit, bytes: text.length });

        // Once-per-run: assert the Admin nav-link is not rendered for
        // customer-member viewers. We check on the first anchor-hit page
        // so the primary nav is mounted; subsequent routes share the
        // same chrome.
        if (anchorHit && adminNavCheckedAt === null) {
          adminNavCheckedAt = route.id;
          adminNavLinkSeen = await page.evaluate(() => {
            const link = document.querySelector('[data-testid="eaos-primary-nav-link-admin"]');
            return Boolean(link);
          });
          if (adminNavLinkSeen) {
            findings.push({
              route: route.id,
              needle: "eaos-primary-nav-link-admin",
              snippet:
                "Admin primary-nav link is rendered for customer-member viewer — operator-only zone should be hidden.",
            });
          }
        }

        for (const needle of FORBIDDEN_NEEDLES) {
          const index = text.indexOf(needle);
          if (index !== -1) {
            const start = Math.max(0, index - 40);
            const end = Math.min(text.length, index + needle.length + 40);
            findings.push({
              route: route.id,
              needle,
              snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
            });
          }
        }
      } catch (error) {
        summary.push({ route: route.id, ok: false, bytes: 0 });
        findings.push({
          route: route.id,
          needle: "<navigation-error>",
          snippet: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await page.close();
      }
    }

    const report = {
      base,
      companyId: SCREENSHOT_COMPANY_ID,
      generatedAt: new Date().toISOString(),
      viewer: "customer-member",
      mode: "populated",
      forbidden: FORBIDDEN_NEEDLES,
      adminNav: {
        checkedAt: adminNavCheckedAt,
        present: adminNavLinkSeen,
      },
      routes: summary,
      findings,
      pass: findings.length === 0,
    };
    await writeFile(resolve(outPath), JSON.stringify(report, null, 2) + "\n", "utf8");

    // eslint-disable-next-line no-console
    console.log(
      `LET-503 — customer string audit: routes=${summary.length}, findings=${findings.length}. Report: ${outPath}`,
    );
    if (findings.length > 0) {
      for (const f of findings) {
        // eslint-disable-next-line no-console
        console.log(`  - ${f.route} :: "${f.needle}" → ${f.snippet}`);
      }
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
}

void run();
