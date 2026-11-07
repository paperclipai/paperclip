#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Screenshots of the artifact-directions lab.
 *
 *   node ui/src/artifact-directions/shot.cjs --port <p> --d <kit|all> --out <dir>
 *        [--s thread,panel,gallery,stack,kinds,board] [--theme dark,light]
 *
 * Writes <out>/<kit>__<surface>__<theme>.png: full page, chrome=0, 1440x900 at
 * deviceScaleFactor 2. The board is a 2880-wide contact sheet composed from
 * those captures (see captureBoard). Exits non-zero on any console error, page error, failed
 * request or HTTP error status — after writing whatever it captured.
 *
 * It does NOT start the dev server.
 */

const fs = require("node:fs");
const path = require("node:path");

const KITS = ["today", "d1-solid", "d2-tint", "d3-tactile", "d4-hybrid", "d5-v1-mvp"];
const SURFACES = ["thread", "panel", "gallery", "stack", "kinds", "board"];
const THEMES = ["dark", "light"];

const HELP = `Usage:
  node ui/src/artifact-directions/shot.cjs --port <p> --d <kit|all> --out <dir> [--s <surfaces>] [--theme <themes>]

  --port   port of a running lab dev server (required)
  --d      ${KITS.join(" | ")} | all   (default: today)
           "all" captures every kit; for the board it captures the one all-kits grid
  --out    output directory (required; created if missing)
  --s      comma-separated: ${SURFACES.join(",")}   (default: all of them)
  --theme  comma-separated: ${THEMES.join(",")}   (default: both)

Start the dev server first (it is not started for you):
  cd ui && npx vite --config vite.artifact-directions.config.mjs --port <p> --strictPort
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=");
      args[key] = inline ?? argv[(i += 1)];
    }
  }
  return args;
}

function list(value, allowed, name) {
  if (!value) return allowed;
  const picked = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = picked.filter((item) => !allowed.includes(item));
  if (unknown.length > 0) fail(`Unknown ${name}: ${unknown.join(", ")} (expected ${allowed.join(", ")})`);
  return picked;
}

function fail(message) {
  console.error(`shot: ${message}\n`);
  console.error(HELP);
  process.exit(2);
}

function loadChromium() {
  // The workspace hoists `@playwright/test`; bare `playwright` only resolves
  // where a package depends on it directly.
  for (const name of ["@playwright/test", "playwright"]) {
    try {
      return require(name).chromium;
    } catch {
      // try the next one
    }
  }
  throw new Error("Playwright is not installed (looked for @playwright/test and playwright). Run pnpm install.");
}

/**
 * Runs inside every frame. The lab answers its API from a fetch stub, so the
 * network going idle says nothing about whether React has finished: wait for
 * fonts and images, then for the DOM to stop changing.
 */
async function settleFrame() {
  // Below-the-fold images are lazy in the product; a full-page capture needs them all.
  for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = "eager";
  await document.fonts.ready;
  const quiet = () =>
    new Promise((resolve) => {
      let timer = setTimeout(done, 400);
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, 400);
      });
      function done() {
        observer.disconnect();
        resolve();
      }
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  await quiet();
  await Promise.all(
    [...document.images].map((img) =>
      img.complete ? null : new Promise((resolve) => ["load", "error"].forEach((type) => img.addEventListener(type, resolve, { once: true }))),
    ),
  );
  // A video preview fades its first frame in once it has seeked (ArtifactCard.tsx); give it that.
  await Promise.all(
    [...document.querySelectorAll("video")].map((video) =>
      video.readyState >= 2 ? null : new Promise((resolve) => {
        ["loadeddata", "error"].forEach((type) => video.addEventListener(type, resolve, { once: true }));
        setTimeout(resolve, 3500);
      }),
    ),
  );
  await quiet();
}

async function capture(browser, base, shot, outDir) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const problems = [];
  let shipped = 0;
  let lastWasShipped = false;
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    lastWasShipped = isShippedNestingWarning(text, lastWasShipped);
    if (lastWasShipped) shipped += 1;
    else problems.push(`console error: ${text}`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("requestfailed", (request) => problems.push(`request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });

  const url = `${base}/?d=${shot.kit}&s=${shot.surface}&theme=${shot.theme}&chrome=0`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
  for (const frame of page.frames()) await frame.evaluate(settleFrame);

  const file = path.join(outDir, `${shot.kit}__${shot.surface}__${shot.theme}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
  return { file, problems, shipped };
}

const BOARD_SURFACES = ["thread", "panel", "gallery", "stack"];
const KIT_NAMES = { today: "0.Today", "d1-solid": "1.Solid", "d2-tint": "2.Tint", "d3-tactile": "3.Tactile", "d4-hybrid": "4.Hybrid", "d5-v1-mvp": "5.MVP V1" };

/**
 * The contact sheet, composed from the per-surface captures already in
 * `outDir` (missing ones are captured first). The in-page board (`s=board`)
 * frames sixteen live copies of the lab, which a dev server takes minutes to
 * serve unbundled; stills of the same views are what a capture needs.
 */
async function captureBoard(browser, base, kit, theme, outDir) {
  const kits = kit === "all" ? KITS : [kit];
  const problems = [];
  for (const k of kits) {
    for (const surface of BOARD_SURFACES) {
      if (fs.existsSync(path.join(outDir, `${k}__${surface}__${theme}.png`))) continue;
      const result = await capture(browser, base, { kit: k, surface, theme }, outDir);
      problems.push(...result.problems);
    }
  }
  const dark = theme === "dark";
  const tile = (k, surface, crop) =>
    `<figure style="height:${crop}px"><img src="${k}__${surface}__${theme}.png" alt="${k} ${surface}"></figure>`;
  const rows = kits
    .map(
      (k) => `<section><h2>${KIT_NAMES[k]}</h2>
        ${tile(k, "thread", 1100)}${tile(k, "panel", 1100)}
        <div class="pair">${tile(k, "gallery", 542)}${tile(k, "stack", 542)}</div></section>`,
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:32px;background:${dark ? "#0f0f0f" : "#e9e9e9"};color:${dark ? "#f5f5f5" : "#171717"};font:600 22px/1.2 Inter,system-ui,sans-serif}
    header,section{display:grid;grid-template-columns:150px repeat(3,minmax(0,1fr));gap:16px;align-items:start}
    header{font:500 13px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin-bottom:12px}
    section{margin-bottom:32px}h2{margin:0;font:inherit}
    figure{margin:0;overflow:hidden;border-radius:6px;outline:1px solid ${dark ? "#ffffff1f" : "#0000001f"}}
    img{display:block;width:100%}.pair{display:grid;gap:16px}
  </style><header><span>${theme}</span><span>Thread</span><span>Panel</span><span>Gallery + stack</span></header>${rows}`;
  const sheet = path.join(outDir, `.board-${kit}-${theme}.html`);
  fs.writeFileSync(sheet, html);
  const context = await browser.newContext({ viewport: { width: 2880, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`file://${sheet}`, { waitUntil: "load" });
  const file = path.join(outDir, `${kit}__board__${theme}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
  fs.unlinkSync(sheet);
  return { file, problems, shipped: 0 };
}

/**
 * The one console error that is the product's, not the lab's: the shipped
 * gallery tile puts its open/download anchors inside the card's own anchor
 * (ArtifactCard.tsx:188-229), and React's dev build reports that as a pair of
 * messages. Only that tile is excused — the first message must name it, and the
 * second is accepted only directly after the first — so the same mistake in a
 * new kit still fails the capture.
 */
function isShippedNestingWarning(text, previousWasShipped) {
  if (text.includes("cannot be a descendant of") && text.includes('data-testid="artifact-card"')) return true;
  return previousWasShipped && text.includes("cannot contain a nested");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.port) fail("--port is required");
  if (!args.out) fail("--out is required");
  const kit = args.d ?? "today";
  if (kit !== "all" && !KITS.includes(kit)) fail(`Unknown --d: ${kit}`);
  const surfaces = list(args.s, SURFACES, "surface");
  const themes = list(args.theme, THEMES, "theme");

  const shots = [];
  for (const surface of [...surfaces.filter((s) => s !== "board"), ...surfaces.filter((s) => s === "board")]) {
    // The board has its own all-kits layout; every other surface is one kit at a time.
    const kits = kit === "all" && surface !== "board" ? KITS : [kit];
    for (const k of kits) for (const theme of themes) shots.push({ kit: k, surface, theme });
  }

  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const base = `http://127.0.0.1:${args.port}`;
  const browser = await loadChromium().launch({ headless: true });
  let failed = 0;
  try {
    for (const shot of shots) {
      const { file, problems, shipped } =
        shot.surface === "board"
          ? await captureBoard(browser, base, shot.kit, shot.theme, outDir)
          : await capture(browser, base, shot, outDir);
      console.log(`${problems.length > 0 ? "FAIL" : "ok  "} ${file}`);
      if (shipped > 0) console.log(`       note: ${shipped} shipped <a>-in-<a> warning(s) from the product's ArtifactCard ignored`);
      for (const problem of [...new Set(problems)]) console.log(`       ${problem}`);
      if (problems.length > 0) failed += 1;
    }
  } finally {
    await browser.close();
  }
  if (failed > 0) {
    console.error(`\nshot: ${failed} of ${shots.length} capture(s) reported errors.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`shot: ${error.message}`);
  process.exit(1);
});
