import pw from "/srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-10724-help-me-think-through-paperclip-workflow-primitives-and-ux/node_modules/.pnpm/playwright-core@1.58.2/node_modules/playwright-core/index.js";
const { chromium } = pw;
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:6177/iframe.html";
const OUT = process.env.OUT_DIR || "/tmp/breakdown-shots";
mkdirSync(OUT, { recursive: true });

const EXEC = "/srv/paperclip/home/.cache/ms-playwright/chromium-1223/chrome-linux/chrome";

function url(id) {
  return `${BASE}?id=${id}&viewMode=story`;
}

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ["--no-sandbox", "--disable-gpu", "--force-color-profile=srgb"],
});
const ctx = await browser.newContext({
  viewport: { width: 1500, height: 1100 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await ctx.newPage();

async function load(id) {
  await page.goto(url(id), { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1200);
}

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log("captured", name);
}

async function clickNav(label) {
  const el = page.getByRole("button", { name: label, exact: true }).first();
  if (await el.count()) {
    await el.click();
  } else {
    await page.getByText(label, { exact: true }).first().click();
  }
  await page.waitForTimeout(700);
}

// 1. Settings — Advanced tab: "Break into smaller pieces" card + summary band
await load("pipelines-breakdown-primitive--settings-break-into-pieces-card");
await page.getByText("Release Coverage", { exact: true }).first().click();
await page.waitForTimeout(600);
await clickNav("Advanced");
await shot("01-settings-break-into-pieces-card");

// 2. Settings — Automation tab: relabel + "Paperclip handles this" + health
await clickNav("Automation");
await shot("02-settings-paperclip-handles-this");

// 3. Board — outbound "Breaks into Features" chip on the source stage column
await load("pipelines-breakdown-primitive--board-connector-chips");
await shot("03-board-breaks-into-chip");

// 4. Board — inbound "Fed by Releases" chip on the target title bar
await load("pipelines-breakdown-primitive--board-fed-by-chip");
await shot("04-board-fed-by-chip");

// 5. Case detail — piece-noun rollup banner + "Built from 5 features"
await load("pipelines-breakdown-primitive--case-detail-pieces-rollup");
await shot("05-case-detail-pieces-rollup");

await browser.close();
console.log("done ->", OUT);
