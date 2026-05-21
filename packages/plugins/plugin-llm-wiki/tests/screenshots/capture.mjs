#!/usr/bin/env node
import { mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const outDir = resolve(pkgRoot, "dist", "screenshots");
const screensDir = resolve(pkgRoot, "screenshots");

mkdirSync(outDir, { recursive: true });
mkdirSync(screensDir, { recursive: true });

const entry = resolve(__dirname, "entry.tsx");

const repoRoot = resolve(pkgRoot, "..", "..", "..");
const reactPath = resolve(repoRoot, "node_modules/.pnpm/react@19.2.4/node_modules/react");
const reactDomPath = resolve(repoRoot, "node_modules/.pnpm/react-dom@19.2.4_react@19.2.4/node_modules/react-dom");

console.log("Bundling screenshot harness…");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: resolve(outDir, "bundle.js"),
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
  alias: {
    "react": reactPath,
    "react-dom": reactDomPath,
    "react-dom/client": resolve(reactDomPath, "client.js"),
    "react/jsx-runtime": resolve(reactPath, "jsx-runtime.js"),
  },
});

copyFileSync(resolve(__dirname, "index.html"), resolve(outDir, "index.html"));

const desktopViewport = { width: 1440, height: 920 };
const mobileViewport = { width: 390, height: 844 };

const desktopTargets = [
  { slug: "01-wiki-browse", view: "wiki-sidebar", section: null },
  { slug: "02-wiki-ingest", view: "wiki-sidebar", section: "ingest" },
  { slug: "03-wiki-query", view: "wiki-sidebar", section: "query" },
  { slug: "04-wiki-lint", view: "wiki-sidebar", section: "lint" },
  { slug: "05-wiki-history", view: "wiki-sidebar", section: "history" },
  { slug: "06-wiki-settings", view: "wiki-sidebar", section: "settings" },
  { slug: "07-host-settings", view: "settings" },
  { slug: "09-sidebar-link", view: "sidebar" },
  { slug: "11-wiki-distillation-settings", view: "wiki-sidebar", section: "settings/distillation" },
  { slug: "12-wiki-distillation-unconfigured", view: "wiki-sidebar", section: "settings/distillation", search: "unconfigured=1" },
  { slug: "20-spaces-sidebar", view: "wiki-sidebar", section: null },
  { slug: "21-spaces-ingest", view: "wiki-sidebar", section: "ingest" },
  { slug: "21a-spaces-ingest-with-disclaimer", view: "wiki-sidebar", section: "ingest" },
  { slug: "22-spaces-edit", view: "wiki-sidebar", section: "settings/spaces/team-research", scrollToText: "Paperclip ingestion" },
  { slug: "22a-spaces-edit-default", view: "wiki-sidebar", section: "settings/spaces/default", scrollToText: "Paperclip ingestion" },
  { slug: "23-spaces-non-default-route", view: "wiki-sidebar", section: "spaces/team-research" },
  { slug: "24-spaces-create-modal", view: "wiki-sidebar", section: null, openCreateSpaceModal: true },
];

const mobileTargets = desktopTargets
  .filter((target) => !target.openCreateSpaceModal)
  .map((target) => ({
    ...target,
    slug: `mobile/${target.slug}`,
    // In the production host, the route sidebar lives in the mobile drawer.
    // The page body should therefore be checked without the desktop sidebar.
    view: target.view === "wiki-sidebar" ? "wiki" : target.view,
    viewport: mobileViewport,
  }));

const targets = [
  ...desktopTargets.map((target) => ({ ...target, viewport: desktopViewport })),
  ...mobileTargets,
];

const playwrightUrl = pathToFileURL(resolve(pkgRoot, "node_modules/playwright/index.mjs")).href;
const playwrightFallback = resolve(pkgRoot, "..", "..", "..", "node_modules", ".pnpm", "playwright@1.58.2", "node_modules", "playwright", "index.mjs");
let playwrightModuleHref = playwrightUrl;
if (!existsSync(resolve(pkgRoot, "node_modules/playwright/index.mjs"))) {
  if (existsSync(playwrightFallback)) {
    playwrightModuleHref = pathToFileURL(playwrightFallback).href;
  } else {
    throw new Error("Cannot locate playwright module");
  }
}
const { chromium } = await import(playwrightModuleHref);

const mimeFor = (ext) => ({
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
})[ext] ?? "application/octet-stream";

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const ext = extname(requestedPath);
  const candidate = ext ? resolve(outDir, "." + requestedPath) : resolve(outDir, "./index.html");
  try {
    const body = readFileSync(candidate);
    res.writeHead(200, { "Content-Type": mimeFor(extname(candidate)) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found: " + candidate);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: desktopViewport, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("console", (msg) => console.log(`  [console.${msg.type()}]`, msg.text()));
page.on("pageerror", (err) => console.error("  [pageerror]", err.message));

for (const target of targets) {
  const sectionPath = target.section ? `/${target.section}` : "";
  const search = target.search ? `?${target.search}` : "";
  const url = `${baseUrl}/PAP/wiki${sectionPath}${search}#${target.view}`;
  console.log(`→ rendering ${target.slug} (${url})`);
  await page.setViewportSize(target.viewport);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  if (target.slug === "09-sidebar-link") {
    await page.addStyleTag({ content: "body { background: var(--sidebar); }" });
  }
  if (target.openCreateSpaceModal) {
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Create space"]');
      if (!btn) throw new Error("Create space button not found in DOM");
      (btn).click();
    });
    await page.waitForSelector('[aria-labelledby="create-space-modal-title"]', { timeout: 5000 });
    await page.waitForTimeout(150);
  }
  if (target.scrollToText) {
    await page.getByText(target.scrollToText).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
  }
  const outFile = resolve(screensDir, `${target.slug}.png`);
  mkdirSync(dirname(outFile), { recursive: true });
  await page.screenshot({ path: outFile, fullPage: false });
  const horizontalOverflow = await page.evaluate(() => {
    const rootOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const bodyOverflow = document.body.scrollWidth - window.innerWidth;
    return Math.max(rootOverflow, bodyOverflow);
  });
  if (horizontalOverflow > 1) {
    throw new Error(`${target.slug} has ${horizontalOverflow}px horizontal overflow at ${target.viewport.width}px`);
  }
  console.log(`  saved ${outFile}`);
}

await browser.close();
server.close();
console.log("Done. Screenshots in", screensDir);
