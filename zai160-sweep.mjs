import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const BASE = "http://127.0.0.1:3100";
const OUT = path.resolve("qa-screenshots-zai160");
fs.mkdirSync(OUT, { recursive: true });

const LOCALES = ["en", "ru", "de", "el", "es", "pt", "uk", "zh"];

const BRAND_TERMS = new Set([
  "paperclip", "claude", "anthropic", "github", "npm", "pnpm", "node",
  "json", "yaml", "html", "css", "tsx", "api", "url", "http", "https",
  "localhost", "git", "cli", "sdk", "uuid", "id", "ok", "n/a",
  "webhook", "cron", "docker", "redis", "postgres", "ai", "ml", "mcp",
  "zai", "ceo", "cto", "cfo", "qa", "dev", "once",
]);

const ENGLISH_PATTERNS = /\b(the|and|or|for|not|with|from|this|that|are|was|were|been|have|has|had|will|would|could|should|can|may|all|any|each|every|some|most|more|less|than|then|when|where|what|which|who|how|why|new|add|edit|delete|remove|create|update|save|cancel|close|open|show|hide|view|list|back|next|prev|submit|confirm|approve|reject|search|filter|type|name|title|description|status|date|time|start|end|done|pending|active|error|warning|info|success|failed|loading|none|empty|default|general|settings|configure|details|overview|actions|options|select|click|enter|press|button|link|page|form|field|input|label|value|check|enable|disable|enabled|disabled|yes|no|true|false|on|off|copy|undo|refresh|reload|download|upload|invite|join|leave|member|role|admin|user|agent|issue|project|goal|task|comment|file|workspace|environment|notification|message|email|send|receive|read|reply|experimental|environments|isolated|workspaces|auto|restart|recovery|lookback|hours|preview|run|now|current|window|last|hour|toggle|behavior|default|evaluated|queued|running|finish|restart|backend|changes|migrations|stale|heartbeat|scheduler|dependency|chains|configured|enable|only|create|cancel|checking|candidates|before|enabling|match|matches|tasks|findings|outside|touched)\b/i;

async function extractVisibleText(page) {
  return await page.evaluate(() => {
    const elements = [];
    const seen = new Set();
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
          if (!text || text.length < 3) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      const parent = node.parentElement;
      if (seen.has(text)) continue;
      seen.add(text);
      elements.push({ text, tag: parent.tagName.toLowerCase() });
    }
    // Also check aria-labels
    document.querySelectorAll("[aria-label]").forEach(el => {
      const val = el.getAttribute("aria-label");
      if (val && val.trim().length >= 3 && !seen.has(val.trim())) {
        seen.add(val.trim());
        elements.push({ text: val.trim(), tag: el.tagName.toLowerCase(), attr: "aria-label" });
      }
    });
    return elements;
  });
}

function isLikelyEnglishLeakage(text) {
  const t = text.trim();
  if (t.length < 3) return false;
  if (/^[\d\s.,:;/\-–—()[\]{}%]+$/.test(t)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(t)) return false;
  if (/^(https?:|\/|[^\s]+@[^\s]+\.)/.test(t)) return false;
  if (BRAND_TERMS.has(t.toLowerCase())) return false;
  if (!/[a-zA-Z]/.test(t)) return false;
  return ENGLISH_PATTERNS.test(t);
}

const results = {};

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

  for (const locale of LOCALES) {
    console.log(`\n--- ${locale.toUpperCase()} ---`);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: {
        cookies: [],
        origins: [{ origin: BASE, localStorage: [{ name: "paperclip_language", value: locale }] }],
      },
    });
    const page = await context.newPage();

    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.goto(`${BASE}/instance/settings/experimental`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);

      const screenshotPath = path.join(OUT, `experimental_${locale}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`  screenshot: ${screenshotPath}`);

      const texts = await extractVisibleText(page);

      const leaks = locale === "en" ? [] : texts.filter(el => isLikelyEnglishLeakage(el.text));

      results[locale] = {
        status: leaks.length === 0 ? "PASS" : "FAIL",
        leakCount: leaks.length,
        leaks: leaks.map(l => ({ text: l.text, tag: l.tag, attr: l.attr })),
        totalTexts: texts.length,
      };

      if (leaks.length === 0) {
        console.log(`  ✅ PASS — no English leakage detected`);
      } else {
        console.log(`  ❌ FAIL — ${leaks.length} English leaks:`);
        for (const leak of leaks.slice(0, 10)) {
          console.log(`    [${leak.tag}${leak.attr ? `[${leak.attr}]` : ""}] "${leak.text}"`);
        }
      }
    } catch (err) {
      results[locale] = { status: "ERROR", error: err.message };
      console.log(`  ❌ ERROR: ${err.message}`);
    } finally {
      await context.close();
    }
  }

  await browser.close();

  const reportPath = path.join(OUT, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

  console.log("\n========== SWEEP SUMMARY ==========");
  let anyFail = false;
  for (const [locale, r] of Object.entries(results)) {
    const icon = r.status === "PASS" ? "✅" : "❌";
    const detail = r.status === "FAIL" ? ` (${r.leakCount} leaks)` : r.status === "ERROR" ? ` (${r.error})` : "";
    console.log(`  ${icon} ${locale}${detail}`);
    if (r.status !== "PASS") anyFail = true;
  }
  console.log("====================================");
  console.log(`Report written to: ${reportPath}`);
  process.exit(anyFail ? 1 : 0);
})();
