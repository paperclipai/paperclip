import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = "http://127.0.0.1:3102";
const ROUTE = "/instance/settings/access";
const SCREENSHOT_DIR = path.resolve(__dirname, "../qa-screenshots-zai159");
// Supported locales per ui/src/locales/en/settings.json language selector (fr is not supported)
const LOCALES = ["en", "ru", "de", "es", "pt", "el", "uk", "zh"];

const BRAND_TERMS = new Set([
  "paperclip", "claude", "anthropic", "github", "npm", "pnpm", "node",
  "json", "yaml", "toml", "html", "css", "tsx", "jsx", "api", "url",
  "http", "https", "localhost", "git", "cli", "sdk", "oauth", "jwt",
  "uuid", "id", "ok", "n/a", "vs", "etc", "e.g.", "i.e.", "todo",
  "webhook", "cron", "docker", "kubernetes", "k8s", "redis", "postgres",
  "openai", "gpt", "llm", "ai", "ml", "mcp", "ux", "ui", "qa",
  "zai", "ceo", "cto", "cfo", "vp", "hr", "coo", "cmo",
]);

// Dynamic data selectors: these render user-supplied values from the database that are not i18n strings.
// Their English appearance is expected because users and companies have English names in the test instance.
const DYNAMIC_DATA_SELECTORS = new Set([
  "button.flex > span.min-w-0.flex-1",       // sidebar logged-in user button
  "div.min-w-0 > div.truncate.font-medium",  // user name in user list
  "div > div.text-lg.font-semibold",         // selected user display name
  "span.space-y-1 > span.block.text-sm",     // company name in company access grid
]);

function isLikelyEnglish(text) {
  const t = text.trim();
  if (t.length < 2) return false;
  if (/^[\d\s.,:;/\-–—()[\]{}]+$/.test(t)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(t)) return false;
  if (/^(https?:|\/|[^\s]+@[^\s]+\.)/.test(t)) return false;
  if (t.length <= 2) return false;
  if (BRAND_TERMS.has(t.toLowerCase())) return false;
  if (!/[a-zA-Z]/.test(t)) return false;
  const englishPatterns = /\b(the|and|or|for|not|with|from|this|that|are|was|were|been|have|has|had|will|would|could|should|can|may|all|any|each|every|some|most|more|less|than|then|when|where|what|which|who|whom|how|why|new|old|add|edit|delete|remove|create|update|save|cancel|close|open|show|hide|view|list|back|next|prev|previous|submit|confirm|approve|reject|deny|search|filter|sort|type|name|title|description|status|priority|date|time|start|end|done|pending|active|error|warning|info|success|failed|loading|none|empty|default|custom|general|settings|profile|access|manage|management|configure|configuration|details|overview|actions|options|properties|select|selected|click|enter|press|button|link|icon|menu|tab|page|form|field|input|label|placeholder|value|check|uncheck|enable|disable|enabled|disabled|yes|no|true|false|on|off|copy|paste|cut|undo|redo|refresh|reload|download|upload|import|export|invite|join|leave|member|role|admin|user|agent|issue|project|goal|task|comment|note|file|folder|workspace|environment|notification|alert|message|email|send|receive|read|unread|reply|forward|archive|trash|spam|instance|company|board|operator|owner|current|memberships)\b/i;
  return englishPatterns.test(t);
}

async function extractVisibleText(page) {
  return await page.evaluate(() => {
    const elements = [];
    const seen = new Set();

    function getSelector(el) {
      if (el.id) return `#${el.id}`;
      const tag = el.tagName.toLowerCase();
      const classes = Array.from(el.classList).filter(c => !c.startsWith("css-")).slice(0, 2).join(".");
      const parent = el.parentElement;
      let prefix = "";
      if (parent && parent !== document.body) {
        if (parent.id) prefix = `#${parent.id} > `;
        else {
          const pTag = parent.tagName.toLowerCase();
          const pClasses = Array.from(parent.classList).filter(c => !c.startsWith("css-")).slice(0, 1).join(".");
          prefix = pClasses ? `${pTag}.${pClasses} > ` : `${pTag} > `;
        }
      }
      return prefix + (classes ? `${tag}.${classes}` : tag);
    }

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const style = window.getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return NodeFilter.FILTER_REJECT;
          }
          const rect = parent.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return NodeFilter.FILTER_REJECT;
          const text = node.textContent.trim();
          if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      const parent = node.parentElement;
      const selector = getSelector(parent);
      const key = `${selector}:${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push({ text, selector, tagName: parent.tagName.toLowerCase() });
    }

    document.querySelectorAll("[placeholder], [aria-label]").forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const selector = getSelector(el);
      for (const attr of ["placeholder", "aria-label"]) {
        const val = el.getAttribute(attr);
        if (val && val.trim().length >= 2) {
          const key = `${selector}[${attr}]:${val.trim()}`;
          if (!seen.has(key)) {
            seen.add(key);
            elements.push({ text: val.trim(), selector: `${selector}[${attr}]`, tagName: el.tagName.toLowerCase(), attribute: attr });
          }
        }
      }
    });

    return elements;
  });
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox"],
  });

  const results = {};
  const allLeaks = [];

  // Get EN baseline
  console.log("Collecting EN baseline...");
  const ctx0 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const p0 = await ctx0.newPage();
  await p0.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await p0.evaluate(() => localStorage.setItem("paperclip_language", "en"));
  await p0.goto(BASE + ROUTE, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await p0.waitForTimeout(2500);
  await p0.screenshot({ path: path.join(SCREENSHOT_DIR, "instance-access_en.png") });
  const enTexts = await extractVisibleText(p0);
  const enBySelector = new Map(enTexts.map(el => [el.selector, el]));
  console.log(`  EN baseline: ${enTexts.length} visible elements`);
  results["en"] = { leakCount: 0, textCount: enTexts.length, pass: true };
  await ctx0.close();

  // Test each non-EN locale
  for (const locale of LOCALES.filter(l => l !== "en")) {
    console.log(`Testing locale: ${locale}`);
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
      const page = await ctx.newPage();
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.evaluate((lang) => localStorage.setItem("paperclip_language", lang), locale);
      await page.goto(BASE + ROUTE, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `instance-access_${locale}.png`) });
      const locTexts = await extractVisibleText(page);
      const locBySelector = new Map(locTexts.map(el => [el.selector, el]));

      let leakCount = 0;
      const leaks = [];

      for (const [selector, locEl] of locBySelector) {
        if (DYNAMIC_DATA_SELECTORS.has(selector)) continue;
        const enEl = enBySelector.get(selector);
        if (!enEl) continue;
        if (locEl.text === enEl.text && isLikelyEnglish(locEl.text)) {
          leakCount++;
          leaks.push({ selector, text: locEl.text, attribute: locEl.attribute || null });
          allLeaks.push({ locale, selector, text: locEl.text, status: "definitely_english" });
        }
      }
      // Also check new elements not in EN baseline
      for (const [selector, locEl] of locBySelector) {
        if (DYNAMIC_DATA_SELECTORS.has(selector)) continue;
        if (enBySelector.has(selector)) continue;
        if (isLikelyEnglish(locEl.text)) {
          leakCount++;
          leaks.push({ selector, text: locEl.text, attribute: locEl.attribute || null, note: "not in en baseline" });
          allLeaks.push({ locale, selector, text: locEl.text, status: "likely_english" });
        }
      }

      results[locale] = { leakCount, textCount: locTexts.length, pass: leakCount === 0, leaks };
      console.log(`  ${locale}: ${locTexts.length} elements, leaks: ${leakCount} → ${leakCount === 0 ? "PASS" : "FAIL"}`);
      await ctx.close();
    } catch (err) {
      console.error(`  Error on ${locale}: ${err.message}`);
      results[locale] = { leakCount: -1, textCount: 0, pass: false, error: err.message };
    }
  }

  await browser.close();

  const totalLeaks = allLeaks.length;
  const passing = Object.values(results).filter(r => r.pass).length;
  const failing = Object.values(results).filter(r => !r.pass).length;

  const report = {
    route: ROUTE,
    timestamp: new Date().toISOString(),
    localesTested: LOCALES,
    totalLeaks,
    passing,
    failing,
    verdict: totalLeaks === 0 ? "PASS" : "FAIL",
    results,
    leaks: allLeaks,
  };

  const reportPath = path.resolve(__dirname, "../qa-zai159-access-sweep.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n=== SWEEP RESULT: ${report.verdict} ===`);
  console.log(`Locales: ${passing} PASS / ${failing} FAIL`);
  console.log(`Total leaks: ${totalLeaks}`);
  if (totalLeaks > 0) {
    for (const leak of allLeaks) {
      console.log(`  [${leak.locale}] "${leak.text}" @ ${leak.selector}`);
    }
  }
  console.log(`Report: ${reportPath}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}/`);

  process.exit(totalLeaks === 0 ? 0 : 1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
