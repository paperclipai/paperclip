import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const BASE = "http://127.0.0.1:3100";
const PREFIX = "ZAI";
const SCREENSHOT_DIR = path.resolve("qa-screenshots-zai176");

const ROUTES = [
  { name: "dashboard",   path: `/${PREFIX}/dashboard`   },
  { name: "activity",    path: `/${PREFIX}/activity`    },
  { name: "agents",      path: `/${PREFIX}/agents/all`  },
  { name: "inbox-mine",  path: `/${PREFIX}/inbox/mine`  },
];

// All 8 locales to sweep (en is reference only)
const ALL_LOCALES = ["de", "el", "es", "fr", "pt", "ru", "uk", "zh"];

// nav.search leakage only matters in these locales
const SEARCH_CHECK_LOCALES = new Set(["el", "es", "pt", "uk", "zh"]);

async function setLocaleAndNavigate(page, locale, url) {
  await page.evaluate((lang) => {
    localStorage.setItem("paperclip_language", lang);
  }, locale);
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

async function extractVisibleText(page) {
  return await page.evaluate(() => {
    const results = [];
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
      results.push({ text, selector, tagName: parent.tagName.toLowerCase() });
    }

    // Also check aria-label and placeholder attributes
    document.querySelectorAll("[placeholder],[aria-label]").forEach(el => {
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
            results.push({ text: val.trim(), selector: `${selector}[${attr}]`, tagName: el.tagName.toLowerCase(), attribute: attr });
          }
        }
      }
    });

    return results;
  });
}

// Returns true if text is the English word "Board" (exact, case-insensitive)
function isEnglishBoard(text) {
  return /^board$/i.test(text.trim());
}

// Returns true if text is the English word "Search" (exact, case-insensitive)
function isEnglishSearch(text) {
  return /^search$/i.test(text.trim());
}

// Heuristic: Is this text in a sidebar/nav context?
function isNavContext(selector) {
  return /nav|sidebar|menu|navigation/i.test(selector);
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox"],
  });

  const boardLeaks = [];
  const searchLeaks = [];
  const results = {}; // locale -> route -> { boardOk, searchOk }

  for (const locale of ALL_LOCALES) {
    results[locale] = {};

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // First load the base URL to establish session/cookies
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);

    for (const route of ROUTES) {
      const url = BASE + route.path;
      await setLocaleAndNavigate(page, locale, url);

      const screenshotPath = path.join(SCREENSHOT_DIR, `${locale}_${route.name}.png`);
      await page.screenshot({ path: screenshotPath });

      const texts = await extractVisibleText(page);

      let boardFound = false;
      let searchFoundInNav = false;

      for (const el of texts) {
        if (isEnglishBoard(el.text)) {
          boardFound = true;
          boardLeaks.push({ locale, route: route.name, path: route.path, selector: el.selector, text: el.text });
        }
        if (SEARCH_CHECK_LOCALES.has(locale) && isEnglishSearch(el.text) && isNavContext(el.selector)) {
          searchFoundInNav = true;
          searchLeaks.push({ locale, route: route.name, path: route.path, selector: el.selector, text: el.text });
        }
      }

      // Also check all Search occurrences for the search locales regardless of context
      // (nav.search may render in non-nav containers)
      if (SEARCH_CHECK_LOCALES.has(locale)) {
        for (const el of texts) {
          if (isEnglishSearch(el.text)) {
            // Check if there's actually a translated version visible too (would indicate the key resolved)
            // If "Search" appears in the nav bar exactly, that's a leak
            const alreadyLogged = searchLeaks.some(
              l => l.locale === locale && l.route === route.name && l.selector === el.selector
            );
            if (!alreadyLogged) {
              // Log any Search occurrence for manual review
              searchLeaks.push({ locale, route: route.name, path: route.path, selector: el.selector, text: el.text, flagged: "review" });
            }
          }
        }
      }

      results[locale][route.name] = {
        boardLeak: boardFound,
        searchLeak: searchFoundInNav,
        screenshot: screenshotPath,
      };

      console.log(`  [${locale}] ${route.name}: board=${boardFound ? "LEAK" : "ok"} search=${SEARCH_CHECK_LOCALES.has(locale) ? (searchFoundInNav ? "LEAK" : "ok") : "n/a"}`);
    }

    await context.close();
  }

  await browser.close();

  // Compute per-locale pass/fail
  const localeSummary = {};
  for (const locale of ALL_LOCALES) {
    const boardFails = Object.values(results[locale]).filter(r => r.boardLeak);
    const searchFails = Object.values(results[locale]).filter(r => r.searchLeak);
    const pass = boardFails.length === 0 && searchFails.length === 0;
    localeSummary[locale] = { pass, boardFails: boardFails.length, searchFails: searchFails.length };
  }

  const overallPass = Object.values(localeSummary).every(l => l.pass);

  const report = {
    sweepId: "ZAI-176",
    timestamp: new Date().toISOString(),
    commit: "fdfbcbc2",
    overallVerdict: overallPass ? "PASS" : "FAIL",
    localeSummary,
    boardLeaks,
    searchLeaks: searchLeaks.filter(l => l.flagged !== "review"),
    searchReviewItems: searchLeaks.filter(l => l.flagged === "review"),
  };

  const reportPath = path.resolve("qa-zai176-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("\n=== ZAI-176 SWEEP RESULTS ===");
  console.log(`Overall verdict: ${report.overallVerdict}`);
  for (const [locale, summary] of Object.entries(localeSummary)) {
    const status = summary.pass ? "PASS" : "FAIL";
    console.log(`  ${locale}: ${status} (board-leaks=${summary.boardFails}, search-leaks=${summary.searchFails})`);
  }
  if (boardLeaks.length > 0) {
    console.log("\nBoard leaks:");
    boardLeaks.forEach(l => console.log(`  [${l.locale}] ${l.route} @ ${l.selector}`));
  }
  if (report.searchLeaks.length > 0) {
    console.log("\nSearch leaks (nav context):");
    report.searchLeaks.forEach(l => console.log(`  [${l.locale}] ${l.route} @ ${l.selector}`));
  }
  console.log(`\nReport saved to: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
