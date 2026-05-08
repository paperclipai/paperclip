import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const BASE = "http://127.0.0.1:3100";
const PREFIX = "ZAI";
const SCREENSHOT_DIR = path.resolve("qa-screenshots-2026-05-06");

const AGENT_KEY = "ceo";
const PROJECT_SLUG = "localization";
const GOAL_ID = "9db92b35-5e38-432a-ad36-f4cc199f644d";
const ISSUE_ID = "ZAI-79";

// Brand / technical terms to exclude from leak detection
const BRAND_TERMS = new Set([
  "paperclip", "claude", "anthropic", "github", "npm", "pnpm", "node",
  "json", "yaml", "toml", "html", "css", "tsx", "jsx", "api", "url",
  "http", "https", "localhost", "git", "cli", "sdk", "oauth", "jwt",
  "uuid", "id", "ok", "n/a", "vs", "etc", "e.g.", "i.e.", "todo",
  "webhook", "cron", "docker", "kubernetes", "k8s", "redis", "postgres",
  "openai", "gpt", "llm", "ai", "ml", "mcp", "ux", "ui", "qa",
  "zai", "ceo", "cto", "cfo", "vp", "hr", "coo", "cmo",
]);

const ROUTES = [
  { name: "dashboard", path: `/${PREFIX}/dashboard` },
  { name: "dashboard-live", path: `/${PREFIX}/dashboard/live` },
  { name: "inbox-mine", path: `/${PREFIX}/inbox/mine` },
  { name: "inbox-recent", path: `/${PREFIX}/inbox/recent` },
  { name: "inbox-unread", path: `/${PREFIX}/inbox/unread` },
  { name: "inbox-all", path: `/${PREFIX}/inbox/all` },
  { name: "inbox-requests", path: `/${PREFIX}/inbox/requests` },
  { name: "issues-list", path: `/${PREFIX}/issues` },
  { name: "search", path: `/${PREFIX}/search` },
  { name: "routines", path: `/${PREFIX}/routines` },
  { name: "goals", path: `/${PREFIX}/goals` },
  { name: "goal-detail", path: `/${PREFIX}/goals/${GOAL_ID}` },
  { name: "projects", path: `/${PREFIX}/projects` },
  { name: "project-detail", path: `/${PREFIX}/projects/${PROJECT_SLUG}` },
  { name: "project-issues", path: `/${PREFIX}/projects/${PROJECT_SLUG}/issues` },
  { name: "project-workspaces", path: `/${PREFIX}/projects/${PROJECT_SLUG}/workspaces` },
  { name: "project-config", path: `/${PREFIX}/projects/${PROJECT_SLUG}/configuration` },
  { name: "project-localization", path: `/${PREFIX}/projects/localization` },
  { name: "agents-detail", path: `/${PREFIX}/agents/${AGENT_KEY}` },
  { name: "agents-all", path: `/${PREFIX}/agents/all` },
  { name: "agents-active", path: `/${PREFIX}/agents/active` },
  { name: "approvals-pending", path: `/${PREFIX}/approvals/pending` },
  { name: "approvals-all", path: `/${PREFIX}/approvals/all` },
  { name: "org", path: `/${PREFIX}/org` },
  { name: "costs", path: `/${PREFIX}/costs` },
  { name: "activity", path: `/${PREFIX}/activity` },
  { name: "company-settings", path: `/${PREFIX}/company/settings` },
  { name: "company-access", path: `/${PREFIX}/company/settings/access` },
  { name: "company-environments", path: `/${PREFIX}/company/settings/environments` },
  { name: "workspaces", path: `/${PREFIX}/workspaces` },
  { name: "design-guide", path: `/${PREFIX}/design-guide` },
  { name: "instance-general", path: `/instance/settings/general` },
  { name: "instance-profile", path: `/instance/settings/profile` },
  { name: "instance-access", path: `/instance/settings/access` },
  { name: "instance-experimental", path: `/instance/settings/experimental` },
  { name: "instance-adapters", path: `/instance/settings/adapters` },
  { name: "user-board", path: `/${PREFIX}/u/board` },
  { name: "onboarding", path: `/onboarding` },
  { name: "issue-detail", path: `/${PREFIX}/issues/${ISSUE_ID}` },
  { name: "project-onboarding", path: `/${PREFIX}/projects/onboarding` },
];

function isLikelyEnglish(text) {
  const t = text.trim();
  if (t.length < 2) return false;
  // Skip pure numbers, dates, codes, UUIDs
  if (/^[\d\s.,:;/\-–—()[\]{}]+$/.test(t)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(t)) return false;
  // Skip URLs, paths, emails
  if (/^(https?:|\/|[^\s]+@[^\s]+\.)/.test(t)) return false;
  // Skip single-char or common abbreviations
  if (t.length <= 2) return false;
  // Check against brand terms
  if (BRAND_TERMS.has(t.toLowerCase())) return false;
  // Must contain at least one Latin letter
  if (!/[a-zA-Z]/.test(t)) return false;
  // Check for common English words that suggest hardcoded English
  const englishPatterns = /\b(the|and|or|for|not|with|from|this|that|are|was|were|been|have|has|had|will|would|could|should|can|may|all|any|each|every|some|most|more|less|than|then|when|where|what|which|who|whom|how|why|new|old|add|edit|delete|remove|create|update|save|cancel|close|open|show|hide|view|list|back|next|prev|previous|submit|confirm|approve|reject|deny|search|filter|sort|type|name|title|description|status|priority|date|time|start|end|done|pending|active|error|warning|info|success|failed|loading|none|empty|default|custom|general|settings|profile|access|manage|management|configure|configuration|details|overview|actions|options|properties|select|selected|click|enter|press|button|link|icon|menu|tab|page|form|field|input|label|placeholder|value|check|uncheck|enable|disable|enabled|disabled|yes|no|true|false|on|off|copy|paste|cut|undo|redo|refresh|reload|download|upload|import|export|invite|join|leave|member|role|admin|user|agent|issue|project|goal|task|comment|note|file|folder|workspace|environment|notification|alert|message|email|send|receive|read|unread|reply|forward|archive|trash|spam)\b/i;
  return englishPatterns.test(t);
}

function buildSelector(element) {
  // Returns a CSS-like selector description
  return element.selector || "unknown";
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
      elements.push({
        text,
        selector,
        tagName: parent.tagName.toLowerCase(),
        rect: (() => {
          const r = parent.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        })(),
      });
    }

    // Also capture placeholder, title, aria-label attributes
    document.querySelectorAll("[placeholder], [title], [aria-label]").forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const selector = getSelector(el);
      for (const attr of ["placeholder", "title", "aria-label"]) {
        const val = el.getAttribute(attr);
        if (val && val.trim().length >= 2) {
          const key = `${selector}[${attr}]:${val.trim()}`;
          if (!seen.has(key)) {
            seen.add(key);
            elements.push({
              text: val.trim(),
              selector: `${selector}[${attr}]`,
              tagName: el.tagName.toLowerCase(),
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              attribute: attr,
            });
          }
        }
      }
    });

    return elements;
  });
}

async function setLocaleAndNavigate(page, locale, url) {
  await page.evaluate((lang) => {
    localStorage.setItem("paperclip_language", lang);
  }, locale);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

const TEST_LOCALES = ["en", "ru", "de", "el", "es", "pt", "uk", "zh"];

function suggestI18nKey(routeName, selector, text) {
  const ns = routeName.replace(/-/g, "_").replace(/detail$/, "").replace(/_$/, "");
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("_");
  if (!slug) return `${ns}.untranslated`;
  return `${ns}.${slug}`;
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const allFindings = [];
  const routeSummaries = [];
  let routesProcessed = 0;

  for (const route of ROUTES) {
    routesProcessed++;
    console.log(`[${routesProcessed}/${ROUTES.length}] Processing: ${route.name} (${route.path})`);

    const url = BASE + route.path;

    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
      });
      const page = await context.newPage();
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);

      // Collect EN baseline first
      await setLocaleAndNavigate(page, "en", url);
      const enScreenPath = path.join(SCREENSHOT_DIR, `${route.name}_en.png`);
      await page.screenshot({ path: enScreenPath });
      const enTexts = await extractVisibleText(page);

      const enBySelector = new Map();
      for (const el of enTexts) {
        enBySelector.set(el.selector, el);
      }

      const routeSummary = {
        route: route.path,
        name: route.name,
        enTextCount: enTexts.length,
        locales: {},
        screenshotEn: `${route.name}_en.png`,
      };

      for (const locale of TEST_LOCALES) {
        await setLocaleAndNavigate(page, locale, url);
        const locScreenPath = path.join(SCREENSHOT_DIR, `${route.name}_${locale}.png`);
        await page.screenshot({ path: locScreenPath });
        const locTexts = await extractVisibleText(page);

        const locBySelector = new Map();
        for (const el of locTexts) {
          locBySelector.set(el.selector, el);
        }

        let leakCount = 0;

        for (const [selector, locEl] of locBySelector) {
          const enEl = enBySelector.get(selector);
          if (!enEl) continue;

          if (locEl.text === enEl.text && isLikelyEnglish(locEl.text)) {
            leakCount++;
            allFindings.push({
              route: route.path,
              routeName: route.name,
              locale,
              selector,
              [`element_text_${locale}`]: locEl.text,
              element_text_en: enEl.text,
              tagName: locEl.tagName,
              rect: locEl.rect,
              attribute: locEl.attribute || null,
              severity: locEl.text.split(/\s+/).length > 3 ? "high" : "medium",
              suggested_i18n_key: suggestI18nKey(route.name, selector, locEl.text),
              status: "definitely_english",
            });
          }
        }

        for (const [selector, locEl] of locBySelector) {
          if (enBySelector.has(selector)) continue;
          if (isLikelyEnglish(locEl.text)) {
            leakCount++;
            allFindings.push({
              route: route.path,
              routeName: route.name,
              locale,
              selector,
              [`element_text_${locale}`]: locEl.text,
              element_text_en: "(not matched in en DOM)",
              tagName: locEl.tagName,
              rect: locEl.rect,
              attribute: locEl.attribute || null,
              severity: "medium",
              suggested_i18n_key: suggestI18nKey(route.name, selector, locEl.text),
              status: "likely_english",
            });
          }
        }

        routeSummary.locales[locale] = {
          textCount: locTexts.length,
          leakCount,
          screenshot: `${route.name}_${locale}.png`,
        };

        console.log(`  → ${locale}: ${locTexts.length} elements, leaks: ${leakCount}`);
      }

      await context.close();
      routeSummaries.push(routeSummary);

    } catch (err) {
      console.error(`  ✗ Error on ${route.name}: ${err.message}`);
      routeSummaries.push({
        route: route.path,
        name: route.name,
        enTextCount: 0,
        locales: {},
        error: err.message,
      });
    }
  }

  await browser.close();

  const jsonPath = path.resolve("qa-dom-leaks.json");
  fs.writeFileSync(jsonPath, JSON.stringify(allFindings, null, 2));

  const summaryPath = path.resolve("qa-dom-walk-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    routesProcessed,
    totalRoutes: ROUTES.length,
    totalLeaks: allFindings.length,
    localesTested: TEST_LOCALES,
    routeSummaries,
  }, null, 2));

  console.log(`\n=== SUMMARY ===`);
  console.log(`Routes processed: ${routesProcessed}/${ROUTES.length}`);
  console.log(`Total DOM leaks found: ${allFindings.length}`);
  console.log(`Locales tested: ${TEST_LOCALES.join(", ")}`);
  console.log(`Findings written to: ${jsonPath}`);
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}/`);

  const sorted = routeSummaries
    .map(r => {
      const total = Object.values(r.locales || {}).reduce((s, l) => s + (l.leakCount || 0), 0);
      return { ...r, totalLeaks: total };
    })
    .filter(r => r.totalLeaks > 0)
    .sort((a, b) => b.totalLeaks - a.totalLeaks);
  console.log(`\nTop offender routes:`);
  for (const r of sorted.slice(0, 15)) {
    const breakdown = Object.entries(r.locales || {}).map(([l, v]) => `${l}:${v.leakCount}`).join(" ");
    console.log(`  ${r.totalLeaks} leaks — ${r.name} (${r.route}) [${breakdown}]`);
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
