import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const BASE = "http://127.0.0.1:3105";
const PREFIX = "SDF";
const OUT = path.resolve("qa-screenshots-zai118");
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    storageState: {
      cookies: [],
      origins: [
        {
          origin: BASE,
          localStorage: [{ name: "paperclip_language", value: "ru" }],
        },
      ],
    },
  });
  const page = await context.newPage();

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
  await page.goto(`${BASE}/${PREFIX}/inbox/mine`, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const file = path.join(OUT, "inbox-mine-ru.png");
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", file);

  await context.close();
  await browser.close();
  console.log("Done. Screenshot in", OUT);
})();
