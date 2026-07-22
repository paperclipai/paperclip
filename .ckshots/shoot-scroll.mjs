// Capture a long form in vertical segments. Usage: node shoot-scroll.mjs <urlPath> <prefix> <segments>
import pw from "/work/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.js";
const { chromium } = pw;
const [, , urlPath = "/", prefix = "seg", segs = "5"] = process.argv;
const base = "http://127.0.0.1:3100";
const url = base + (urlPath.startsWith("/") ? urlPath : "/" + urlPath);
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(2000);
// Find the scrollable container (the main panel), fall back to window.
const n = Number(segs);
const out = [];
for (let i = 0; i < n; i++) {
  const f = `${prefix}-${i}.png`;
  await page.screenshot({ path: f });
  out.push(f);
  // scroll the element under the form by ~820px; scroll both the inner scroller and window
  await page.evaluate(() => {
    const main = document.querySelector("main") || document.scrollingElement;
    const scrollers = [main, document.scrollingElement, ...document.querySelectorAll("*")].filter(Boolean);
    // pick the tallest overflow:auto/scroll element
    let best = document.scrollingElement, bestH = 0;
    document.querySelectorAll("div,main,section").forEach((el) => {
      const s = getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight && el.scrollHeight > bestH) {
        best = el; bestH = el.scrollHeight;
      }
    });
    best.scrollBy(0, 820);
  });
  await page.waitForTimeout(700);
}
console.log(JSON.stringify({ url, shots: out }));
await browser.close();
