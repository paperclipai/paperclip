/**
 * ZAI-147: Cross-locale screenshot sweep #2 — i18n R3 post code+JSON fix
 * 8 locales × 5 pages, enhanced Russian AC checks
 * Locale switching: uses the in-app LanguageSwitcher button (aria-label="Change language")
 * which calls i18n.changeLanguage() + persists to localStorage('paperclip_language').
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import http from 'http';

const API_BASE = 'http://127.0.0.1:3100/api';
const APP_BASE = 'http://127.0.0.1:3100';
const TOKEN = process.env.PAPERCLIP_API_KEY;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const COMPANY_ID = '13e61789-5895-451b-95a8-a7457a310c9e';
const ZAI147_ID = 'cc5fb2ea-affc-4f1f-a1f2-c143e0107b01';
const ZAI139_ID = 'e1e0e7df-7a38-45a0-9434-95abc7e0f99e';

// ZAI-147 locale set: el and uk replace fr and it vs ZAI-145
const LOCALES = ['en', 'ru', 'de', 'el', 'es', 'pt', 'uk', 'zh'];

// Maps locale code → native name shown in LanguageSwitcher dropdown
const LOCALE_NATIVE = {
  en: 'English', ru: 'Русский', uk: 'Українська', es: 'Español',
  de: 'Deutsch', pt: 'Português (BR)', zh: '中文', el: 'Ελληνικά',
};

const EN_LEAKAGE_SIGNALS = [
  'Agents', 'Properties', 'Priority', 'Status', 'Inbox',
  'Activity', 'Settings', 'New Issue', 'Search', 'Board',
  'High', 'Medium', 'Low', 'Urgent', 'days ago', 'hours ago', 'minutes ago',
  'in progress', 'todo', 'done',
];

// Russian acceptance criteria
const RU_CHECKS = [
  { label: 'Agents heading → Агенты',       mustContain: 'Агенты' },
  { label: 'Properties → Свойства',          mustContain: 'Свойства' },
  { label: 'Board → Совет',                  mustContain: 'Совет' },
  { label: 'Priority labels in Russian',     mustContain: 'Высокий', alt: ['Средний', 'Низкий', 'Срочный'] },
];

const SCREENSHOT_DIR = 'qa-zai147-screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + urlPath);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'x-paperclip-run-id': RUN_ID,
        'Content-Type': 'application/json',
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Switch locale using the in-app LanguageSwitcher button.
 * Sidebar has a button[aria-label="Change language"] which opens a dropdown.
 * Clicking the native name item triggers i18n.changeLanguage() + localStorage persist.
 */
async function switchLocale(page, locale) {
  const nativeName = LOCALE_NATIVE[locale];
  if (!nativeName) {
    console.log(`    WARNING: no native name for locale ${locale}, skipping switch`);
    return false;
  }

  try {
    const triggerBtn = page.locator('button[aria-label="Change language"]').first();
    if (await triggerBtn.count() === 0) {
      console.log(`    WARNING: LanguageSwitcher button not found`);
      return false;
    }
    await triggerBtn.click();
    await page.waitForTimeout(300);

    // Click the language item in the dropdown
    const langItem = page.locator(`[role="menuitem"]:has-text("${nativeName}")`).first();
    if (await langItem.count() === 0) {
      // Fallback: try by text content
      await page.keyboard.press('Escape');
      console.log(`    WARNING: language item "${nativeName}" not found in dropdown`);
      return false;
    }
    await langItem.click();
    await page.waitForTimeout(1000); // Wait for React re-render

    return true;
  } catch (err) {
    console.log(`    WARNING: locale switch error: ${err.message.slice(0, 80)}`);
    return false;
  }
}

async function getIssueId() {
  const issues = await apiCall('GET', `/companies/${COMPANY_ID}/issues?status=in_progress&limit=3`).catch(() => null);
  if (issues?.issues?.length > 0) return issues.issues[0].id;
  const issues2 = await apiCall('GET', `/companies/${COMPANY_ID}/issues?limit=3`).catch(() => null);
  if (issues2?.issues?.length > 0) return issues2.issues[0].id;
  return null;
}

const results = { locales: {}, ruChecks: [], summary: [] };

async function runSweep() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const sampleIssueId = await getIssueId();
  console.log('Sample issue ID:', sampleIssueId || 'none — skipping detail page');

  const PAGES = [
    { key: 'dashboard',    path: '/',         label: 'Dashboard' },
    { key: 'inbox',        path: '/inbox',    label: 'Inbox' },
    { key: 'agents',       path: '/agents',   label: 'Agents' },
    { key: 'activity',     path: '/activity', label: 'Activity Feed' },
    ...(sampleIssueId ? [{ key: 'issue_detail', path: `/issues/${sampleIssueId}`, label: 'Issue Detail' }] : []),
  ];

  // Load the app once, then switch locale via the UI switcher for each locale
  await page.goto(`${APP_BASE}/`, { timeout: 15000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  for (const locale of LOCALES) {
    console.log(`\n=== Locale: ${locale} ===`);
    results.locales[locale] = { pages: {}, leakage: [], pass: true };
    const locDir = path.join(SCREENSHOT_DIR, locale);
    fs.mkdirSync(locDir, { recursive: true });

    // Switch to the target locale via the LanguageSwitcher
    if (locale !== 'en') {
      const switched = await switchLocale(page, locale);
      console.log(`  Locale switch: ${switched ? 'OK' : 'FAILED'}`);
    } else {
      // Make sure we start in English
      const switched = await switchLocale(page, 'en');
      console.log(`  Locale switch to en: ${switched ? 'OK' : 'using default'}`);
    }

    for (const pg of PAGES) {
      try {
        // Navigate to page (locale already set in i18n, will persist via React context)
        await page.goto(`${APP_BASE}${pg.path}`, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        // After navigation, i18n resets to getInitialLanguage() — need to re-switch
        // unless we're already in the right locale from a prior switch on this page load
        // Re-switch locale to ensure it's applied on each navigation
        if (locale !== 'en') {
          await switchLocale(page, locale);
        }

        // Open inbox filter dropdown
        if (pg.key === 'inbox') {
          const filterBtn = page.locator(
            '[data-testid="filters-btn"], button:has-text("Filter"), button:has-text("Фильтр"), button:has-text("Filtr"), button:has-text("Filtro")'
          ).first();
          if (await filterBtn.count() > 0) {
            await filterBtn.click().catch(() => {});
            await page.waitForTimeout(800);
          }
        }

        // Command palette screenshot on dashboard
        if (pg.key === 'dashboard') {
          await page.keyboard.press('Meta+k');
          await page.waitForTimeout(600);
          const cmdPalette = page.locator('[data-testid="command-palette"], [role="dialog"][aria-label*="command"], [cmdk-root]').first();
          if (await cmdPalette.count() > 0) {
            await page.screenshot({ path: path.join(locDir, 'command_palette.png') });
            results.locales[locale].pages['command_palette'] = { status: 'SCREENSHOT' };
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }

        const screenshotPath = path.join(locDir, `${pg.key}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

        // English leakage check (non-English locales)
        const leaks = [];
        if (locale !== 'en') {
          for (const signal of EN_LEAKAGE_SIGNALS) {
            const regex = new RegExp(`\\b${signal}\\b`, 'g');
            if (regex.test(bodyText)) leaks.push(signal);
          }
        }

        // Russian-specific checks
        const ruResults = [];
        if (locale === 'ru') {
          for (const check of RU_CHECKS) {
            const found = bodyText.includes(check.mustContain) ||
              (check.alt && check.alt.some(a => bodyText.includes(a)));
            ruResults.push({ check: check.label, result: found ? 'PASS' : `MISS — expected: ${check.mustContain}` });
          }

          const hasRuTime = bodyText.includes('назад') || bodyText.includes('час') ||
            bodyText.includes('мин') || bodyText.includes('день') || bodyText.includes('дней');
          ruResults.push({ check: 'Relative times in Russian', result: hasRuTime ? 'PASS' : 'MISS — no Russian time strings found' });

          if (pg.key === 'activity') {
            const hasRuVerbs = bodyText.includes('создал') || bodyText.includes('изменил') ||
              bodyText.includes('обновил') || bodyText.includes('закрыл') || bodyText.includes('добавил');
            ruResults.push({ check: 'Activity verbs in Russian', result: hasRuVerbs ? 'PASS' : 'MISS — no Russian activity verbs found' });
          }

          const i18nKeyPattern = /\b[a-z_]+\.[a-z_]+\b/g;
          const rawKeys = (bodyText.match(i18nKeyPattern) || [])
            .filter(k => k.includes('.') && k.length > 8 && !k.includes('://'));
          ruResults.push({ check: 'No raw i18n keys', result: rawKeys.length > 0 ? `FAIL — found: ${rawKeys.slice(0, 5).join(', ')}` : 'PASS' });
        }

        const status = leaks.length > 0 ? 'WARN' : 'PASS';
        if (leaks.length > 0) results.locales[locale].pass = false;
        results.locales[locale].pages[pg.key] = { status, leaks, screenshot: screenshotPath };
        if (leaks.length > 0) results.locales[locale].leakage.push({ page: pg.key, leaks });
        if (locale === 'ru') results.ruChecks.push(...ruResults);

        const leakStr = leaks.length > 0 ? ` LEAKAGE: [${leaks.join(',')}]` : '';
        console.log(`  ${pg.key}: ${status}${leakStr}`);
        if (locale === 'ru') ruResults.forEach(r => console.log(`    RU: ${r.check} → ${r.result}`));

      } catch (err) {
        console.log(`  ${pg.key}: ERROR — ${err.message.slice(0, 120)}`);
        results.locales[locale].pages[pg.key] = { status: 'ERROR', error: err.message };
        results.locales[locale].pass = false;
      }
    }

    // Switch back to English between locales so the next locale starts from known state
    if (locale !== 'en') {
      await page.goto(`${APP_BASE}/`, { timeout: 15000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await switchLocale(page, 'en');
    }
  }

  await browser.close();

  for (const locale of LOCALES) {
    const loc = results.locales[locale];
    const pageCount = Object.keys(loc.pages).length;
    const leakCount = loc.leakage.length;
    const verdict = loc.pass ? 'PASS' : (leakCount > 0 ? 'WARN' : 'FAIL');
    results.summary.push({ locale, verdict, pageCount, leakCount });
    console.log(`\n${locale}: ${verdict} (${pageCount} pages, ${leakCount} with leakage)`);
  }

  return results;
}

(async () => {
  console.log('ZAI-147: Cross-locale screenshot sweep #2 (final — via LanguageSwitcher UI)...');
  const results = await runSweep();

  const totalPass = results.summary.filter(r => r.verdict === 'PASS').length;
  const totalWarn = results.summary.filter(r => r.verdict === 'WARN').length;
  const totalFail = results.summary.filter(r => r.verdict === 'FAIL').length;

  let hasLeakage = false;
  for (const locale of LOCALES) {
    if (locale !== 'en' && results.locales[locale]?.leakage?.length > 0) {
      hasLeakage = true;
      break;
    }
  }

  const overallVerdict = totalFail === 0 && totalWarn === 0 ? '✅ ALL PASS' :
    totalFail === 0 ? `⚠️ ${totalWarn} WARN (English leakage detected)` : `❌ ${totalFail} FAIL`;

  const ruChecksSeen = new Set();
  const ruChecksSummary = results.ruChecks.filter(c => {
    const key = c.check + c.result;
    if (ruChecksSeen.has(key)) return false;
    ruChecksSeen.add(key);
    return true;
  });

  console.log('\n--- FINAL RESULTS ---');
  console.log(overallVerdict);

  const commentBody = `## ZAI-147 Cross-Locale Sweep #2 — FINAL RESULTS (via LanguageSwitcher UI)

**Overall verdict: ${overallVerdict}**

*Note: Previous sweep results used wrong localStorage key. This run uses the actual LanguageSwitcher button (i18n.changeLanguage) for correct locale switching.*

### Summary (${LOCALES.length} locales × 4-5 pages)

| Locale | Verdict | Leakage pages |
|--------|---------|---------------|
${results.summary.map(r => `| ${r.locale} | ${r.verdict} | ${r.leakCount} |`).join('\n')}

**${totalPass} PASS / ${totalWarn} WARN / ${totalFail} FAIL**

### Russian (ru) Acceptance Criteria
${ruChecksSummary.length > 0 ? ruChecksSummary.map(c => `- **${c.check}**: ${c.result}`).join('\n') : '(no Russian checks recorded)'}

### English Leakage (non-en locales)
${hasLeakage ?
    LOCALES.filter(l => l !== 'en' && results.locales[l]?.leakage?.length > 0)
      .map(l => `**${l}**: ${results.locales[l].leakage.map(x => `${x.page}[${x.leaks.join(',')}]`).join(', ')}`)
      .join('\n') :
    'None detected ✅'}

Screenshots in \`qa-zai147-screenshots/\`.`;

  // Post addendum to ZAI-147 (already done, adding final results)
  const resp147 = await apiCall('POST', `/issues/${ZAI147_ID}/comments`, { body: commentBody });
  console.log('\nComment posted to ZAI-147:', resp147?.id || JSON.stringify(resp147)?.slice(0, 100));

  // Post to ZAI-139
  const zai139Body = `## ZAI-147 sweep #2 final results for ZAI-139

**Overall: ${overallVerdict}**

| Locale | Verdict | Leakage pages |
|--------|---------|---------------|
${results.summary.map(r => `| ${r.locale} | ${r.verdict} | ${r.leakCount} |`).join('\n')}

### Russian AC
${ruChecksSummary.length > 0 ? ruChecksSummary.map(c => `- **${c.check}**: ${c.result}`).join('\n') : '(see ZAI-147 for details)'}

${hasLeakage ? `### Remaining leakage\n${LOCALES.filter(l => l !== 'en' && results.locales[l]?.leakage?.length > 0).map(l => `- **${l}**: ${results.locales[l].leakage.map(x => `${x.page}: [${x.leaks.join(', ')}]`).join('; ')}`).join('\n')}` : '### English leakage: None ✅'}`;

  const resp139 = await apiCall('POST', `/issues/${ZAI139_ID}/comments`, { body: zai139Body });
  console.log('Comment posted to ZAI-139:', resp139?.id || JSON.stringify(resp139)?.slice(0, 100));

  console.log('\nZAI-147 sweep #2 final run complete.');
})().catch(err => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
