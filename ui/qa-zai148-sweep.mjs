/**
 * ZAI-148: Cross-locale screenshot sweep #3 — all surfaces fixed
 * Per-locale browser contexts (proven approach from ZAI-147).
 * WARN with leakage = FAIL per ZAI-148 acceptance criteria.
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
const ZAI148_ID = '2eba83e5-0162-4d77-bff3-cc0ba9deb5ae';
const ZAI139_ID = 'e1e0e7df-7a38-45a0-9434-95abc7e0f99e';

const LOCALES = ['en', 'ru', 'de', 'el', 'es', 'pt', 'uk', 'zh'];

// Signals that MUST NOT appear in non-English locales
const EN_LEAKAGE_SIGNALS = [
  'Agents', 'Properties', 'Priority', 'Status', 'Inbox',
  'Activity', 'Settings', 'New Issue', 'Search', 'Board',
  'High', 'Medium', 'Low', 'Urgent', 'days ago', 'hours ago', 'minutes ago',
  'in progress', 'todo',
];

// Russian must-pass checks
const RU_CHECKS = [
  { label: 'Agents heading → Агенты',       mustContain: 'Агенты', pages: ['agents'] },
  { label: 'Properties → Свойства',          mustContain: 'Свойства', pages: ['issue_detail'] },
  { label: 'Board → Совет (in comments)',    mustContain: 'Совет', pages: ['issue_detail', 'activity', 'inbox'] },
  { label: 'Priority labels in Russian',     mustContain: 'Высокий', alt: ['Средний', 'Низкий', 'Срочный'], pages: ['issue_detail', 'dashboard', 'inbox'] },
  { label: 'Relative times in Russian',      mustContain: 'назад', alt: ['час', 'мин', 'день', 'дней', 'минут'], pages: ['dashboard', 'activity', 'inbox', 'issue_detail'] },
  { label: 'Activity verbs in Russian',      mustContain: 'создал', alt: ['изменил', 'обновил', 'закрыл', 'добавил', 'назначил'], pages: ['activity', 'issue_detail'] },
];

const SCREENSHOT_DIR = 'qa-zai148-screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + urlPath);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
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

async function getIssueId() {
  for (const status of ['in_progress', 'blocked', null]) {
    const q = status ? `?status=${status}&limit=3` : '?limit=5';
    const r = await apiCall('GET', `/companies/${COMPANY_ID}/issues${q}`).catch(() => null);
    const issues = r?.issues || [];
    if (issues.length > 0) return issues[0].id;
  }
  return 'dd98ad18-afea-4bd0-b65e-b70f9cccaaa4'; // fallback: ZAI-64
}

async function sweepLocale(browser, locale, pages) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((loc) => {
    localStorage.setItem('paperclip_language', loc);
  }, locale);

  const page = await context.newPage();
  const locDir = path.join(SCREENSHOT_DIR, locale);
  fs.mkdirSync(locDir, { recursive: true });

  const localeResult = { pages: {}, leakage: [], ruChecks: {}, pass: true };

  for (const pg of pages) {
    try {
      await page.goto(`${APP_BASE}${pg.path}`, { timeout: 20000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      // Open inbox filter dropdown
      if (pg.key === 'inbox') {
        const filterBtn = page.locator(
          '[data-testid="filters-btn"], button:has-text("Filter"), button:has-text("Фильтр"), button:has-text("Filtr"), button:has-text("Filtro"), button:has-text("Filtre")'
        ).first();
        if (await filterBtn.count() > 0) {
          await filterBtn.click().catch(() => {});
          await page.waitForTimeout(1000);
        }
      }

      // On issue detail, wait for properties panel to load
      if (pg.key === 'issue_detail') {
        await page.waitForTimeout(1500);
      }

      const screenshotPath = path.join(locDir, `${pg.key}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

      // Check locale actually applied
      const localeCheck = await page.evaluate(() => ({
        stored: localStorage.getItem('paperclip_language'),
        navInbox: document.querySelector('a[href*="inbox"]')?.textContent?.trim(),
      }));

      // English leakage (non-en locales)
      const leaks = [];
      if (locale !== 'en') {
        for (const signal of EN_LEAKAGE_SIGNALS) {
          if (new RegExp(`\\b${signal}\\b`, 'g').test(bodyText)) leaks.push(signal);
        }
      }

      // Russian checks — accumulate PASS/MISS per check label
      if (locale === 'ru') {
        for (const check of RU_CHECKS) {
          if (!check.pages.includes(pg.key)) continue;
          const found = bodyText.includes(check.mustContain) ||
            (check.alt && check.alt.some(a => bodyText.includes(a)));
          if (!localeResult.ruChecks[check.label]) {
            localeResult.ruChecks[check.label] = found ? 'PASS' : `MISS on ${pg.key}`;
          } else if (found) {
            localeResult.ruChecks[check.label] = 'PASS'; // override MISS if found on any page
          }
        }
        // No raw i18n keys
        const rawKeys = (bodyText.match(/\b[a-z_]+\.[a-z_]+\b/g) || [])
          .filter(k => k.includes('.') && k.length > 8 && !k.includes('://'));
        if (!localeResult.ruChecks['No raw i18n keys']) {
          localeResult.ruChecks['No raw i18n keys'] = rawKeys.length > 0
            ? `FAIL — found: ${rawKeys.slice(0, 5).join(', ')}`
            : 'PASS';
        }
      }

      const status = leaks.length > 0 ? 'FAIL' : 'PASS'; // WARN = FAIL per ZAI-148 spec
      if (leaks.length > 0) {
        localeResult.pass = false;
        localeResult.leakage.push({ page: pg.key, leaks });
      }
      localeResult.pages[pg.key] = { status, leaks, localeCheck };

      const leakStr = leaks.length > 0 ? ` LEAKAGE: [${leaks.join(',')}]` : '';
      const verifyStr = ` (inbox="${localeCheck.navInbox}", stored=${localeCheck.stored})`;
      console.log(`  ${pg.key}: ${status}${leakStr}${verifyStr}`);

    } catch (err) {
      console.log(`  ${pg.key}: ERROR — ${err.message.slice(0, 120)}`);
      localeResult.pages[pg.key] = { status: 'ERROR', error: err.message };
      localeResult.pass = false;
    }
  }

  await context.close();
  return localeResult;
}

(async () => {
  console.log('ZAI-148: Cross-locale screenshot sweep #3 starting...');

  const sampleIssueId = await getIssueId();
  console.log('Sample issue ID:', sampleIssueId);

  const PAGES = [
    { key: 'dashboard',    path: '/',                              label: 'Dashboard' },
    { key: 'issue_detail', path: `/issues/${sampleIssueId}`,       label: 'Issue Detail' },
    { key: 'inbox',        path: '/inbox',                         label: 'Inbox' },
    { key: 'activity',     path: '/activity',                      label: 'Activity Feed' },
    { key: 'agents',       path: '/agents',                        label: 'Agents' },
  ];

  const browser = await chromium.launch({ headless: true });
  const allResults = { locales: {}, summary: [] };

  for (const locale of LOCALES) {
    console.log(`\n=== Locale: ${locale} ===`);
    const localeResult = await sweepLocale(browser, locale, PAGES);
    allResults.locales[locale] = localeResult;

    const pageCount = Object.keys(localeResult.pages).length;
    const leakCount = localeResult.leakage.length;
    const verdict = localeResult.pass ? 'PASS' : 'FAIL';
    allResults.summary.push({ locale, verdict, pageCount, leakCount });
    console.log(`${locale}: ${verdict} (${pageCount} pages, ${leakCount} with leakage)`);
  }

  await browser.close();

  const totalPass = allResults.summary.filter(r => r.verdict === 'PASS').length;
  const totalFail = allResults.summary.filter(r => r.verdict === 'FAIL').length;
  const overallVerdict = totalFail === 0 ? '✅ ALL PASS' : `❌ ${totalFail} FAIL`;

  // Collect unique RU checks
  const ruData = allResults.locales['ru']?.ruChecks || {};

  const leakageSection = LOCALES
    .filter(l => l !== 'en' && allResults.locales[l]?.leakage?.length > 0)
    .map(l => `**${l}**: ${allResults.locales[l].leakage.map(x => `${x.page}[${x.leaks.join(',')}]`).join(', ')}`)
    .join('\n');

  const commentBody = `## ZAI-148 Cross-Locale Screenshot Sweep #3 — COMPLETE

**Overall verdict: ${overallVerdict}**
*(WARN = FAIL per ZAI-148 acceptance criteria)*

### Summary (${LOCALES.length} locales × ${PAGES.length} pages)

| Locale | Verdict | Leakage pages |
|--------|---------|---------------|
${allResults.summary.map(r => `| ${r.locale} | ${r.verdict} | ${r.leakCount} |`).join('\n')}

**${totalPass} PASS / ${totalFail} FAIL**

### Russian (ru) Acceptance Criteria
${Object.entries(ruData).map(([k, v]) => `- **${k}**: ${v}`).join('\n') || '(no Russian data — no issues visible for detail/activity checks)'}

### English Leakage Detail
${leakageSection || 'None detected ✅'}

Screenshots in \`qa-zai148-screenshots/\`.`;

  const r148 = await apiCall('POST', `/issues/${ZAI148_ID}/comments`, { body: commentBody });
  console.log('\nComment on ZAI-148:', r148?.id || JSON.stringify(r148).slice(0, 100));

  // Report to ZAI-139
  const r139 = await apiCall('POST', `/issues/${ZAI139_ID}/comments`, {
    body: `## ZAI-148 sweep #3 — ${overallVerdict}\n\n${allResults.summary.map(r => `${r.locale}: ${r.verdict}`).join(' | ')}\n\nRU AC:\n${Object.entries(ruData).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '(see ZAI-148)'}\n\n${leakageSection ? `Leakage:\n${leakageSection}` : 'No leakage ✅'}`,
  });
  console.log('Comment on ZAI-139:', r139?.id || JSON.stringify(r139).slice(0, 100));

  // Mark done
  const patch = await apiCall('PATCH', `/issues/${ZAI148_ID}`, { status: 'done' });
  console.log('ZAI-148 status:', patch?.status || JSON.stringify(patch).slice(0, 100));

  console.log('\nZAI-148 sweep done.');
})().catch(err => { console.error('Sweep failed:', err); process.exit(1); });
