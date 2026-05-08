import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const BASE = "http://127.0.0.1:3105";
const PREFIX = "CMP";
const AGENT_ID = "7689bc5a-3b58-4cd6-bab9-437747525298";
const OUT = path.resolve("qa-screenshots-zai92");
fs.mkdirSync(OUT, { recursive: true });

const ROUTES = [
  { name: "agent-config", path: `/${PREFIX}/agents/${AGENT_ID}/configuration` },
  { name: "agent-create", path: `/${PREFIX}/agents/new` },
];

async function shoot(page, lang, route) {
  await page.goto(BASE + route.path, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const file = path.join(OUT, `${route.name}_${lang}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("wrote", file);
}

(async () => {
  const browser = await chromium.launch();
  for (const lang of ["en", "ru"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1600 },
      storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: "paperclip_language", value: lang }] }] },
    });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    for (const route of ROUTES) {
      try {
        await shoot(page, lang, route);
      } catch (e) {
        console.error("fail", route.name, lang, e.message);
      }
    }
    await context.close();
  }
  await browser.close();
})();
