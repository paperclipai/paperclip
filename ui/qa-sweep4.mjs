/**
 * ZAI sweep #4: Post-all-fixes cross-locale sweep
 * CRITICAL FIX: Uses /:companyKey/ prefixed URLs (ZAI = company issuePrefix)
 * Per-locale browser contexts with addInitScript (proven correct method).
 * Any English leakage = FAIL per spec.
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
const COMPANY_PREFIX = 'ZAI';
const SWEEP4_ID = '49a1c6ff-1d4a-4edb-8324-87d8bf37ae11';
const ZAI139_ID = 'e1e0e7df-7a38-45a0-9434-95abc7e0f99e';

const LOCALES = ['en', 'ru', 'de', 'el', 'es', 'pt', 'uk', 'zh'];

const EN_LEAKAGE_SIGNALS = [
  'Agents', 'Properties', 'Priority', 'Status', 'Inbox',
  'Activity', 'Settings', 'New Issue', 'Search', 'Board',
  'High', 'Medium', 'Low', 'Urgent', 'days ago', 'hours ago', 'minutes ago',
  'in progress', 'todo',
];

const RU_CHECKS = [
  { label: 'Agents heading -> Агенты',      mustContain: 'Агенты',     pages: ['agents'] },
  { label: 'Properties -> Свойства',         mustContain: 'Свойства',   pages: ['issue_detail'] },
  { label: 'Board -> Совет',                mustContain: 'Совет',      pages: ['issue_detail', 'activity', 'inbox'] },
  { label: 'Priority labels in Russian',    mustContain: 'Высокий',    alt: ['Средний', 'Низкий', 'Срочный'], pages: ['issue_detail', 'dashboard', 'inbox'] },
  { label: 'Relative times in Russian',     mustContain: 'назад',      alt: ['час', 'мин', 'день', 'дней', 'минут'], pages: ['dashboard', 'activity', 'inbox', 'issue_detail'] },
  { label: 'Activity verbs in Russian',     mustContain: 'создал',     alt: ['изменил', 'обновил', 'закрыл', 'добавил', 'назначил'], pages: ['activity', 'issue_detail'] },
  { label: 'Sidebar nav in Russian',        mustContain: 'Входящие',   alt: ['Настройки', 'Задачи', 'Активность'], pages: ['dashboard', 'agents', 'activity', 'inbox'] },
];

const SCREENSHOT_DIR = 'qa-sweep4-screenshots';
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
  for (const q of ['?status=in_progress&limit=3', '?status=blocked&limit=3', '?limit=5']) {
    const r = await apiCall('GET', `/companies/${COMPANY_ID}/issues${q}`).catch(() => null);
    const issues = r?.issues || (Array.isArray(r) ? r : []);
    if (issues.length > 0) return issues[0].id;
  }
  return 'dd98ad18-afea-4bd0-b65e-b70f9cccaaa4';
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
      await page.goto(`${APP_BASE}${pg.path}`, { timeout: 25000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

      // Verify page loaded correctly (not "Company not found")
      const isNotFound = bodyText.includes('Company not found') || bodyText.includes('No company matches');
      if (isNotFound) {
        console.log(`  ${pg.key}: ERROR — Company not found (wrong URL: ${pg.path})`);
        localeResult.pages[pg.key] = { status: 'ERROR', error: 'Company not found — URL routing issue' };
        localeResult.pass = false;
        continue;
      }

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

      if (pg.key === 'issue_detail') {
        await page.waitForTimeout(1500);
      }

      const screenshotPath = path.join(locDir, `${pg.key}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      const localeCheck = await page.evaluate(() => ({
        stored: localStorage.getItem('paperclip_language'),
        navActivity: document.querySelector('a[href*="activity"]')?.textContent?.trim(),
      }));

      const leaks = [];
      if (locale !== 'en') {
        for (const signal of EN_LEAKAGE_SIGNALS) {
          if (new RegExp(`\\b${signal}\\b`, 'g').test(bodyText)) leaks.push(signal);
        }
      }

      if (locale === 'ru') {
        for (const check of RU_CHECKS) {
          if (!check.pages.includes(pg.key)) continue;
          const found = bodyText.includes(check.mustContain) ||
            (check.alt && check.alt.some(a => bodyText.includes(a)));
          if (!localeResult.ruChecks[check.label]) {
            localeResult.ruChecks[check.label] = found ? 'PASS' : `MISS on ${pg.key}`;
          } else if (found) {
            localeResult.ruChecks[check.label] = 'PASS';
          }
        }
        const rawKeys = (bodyText.match(/\b[a-z_]+\.[a-z_]+\b/g) || [])
          .filter(k => k.length > 8 && !k.includes('://'));
        if (!localeResult.ruChecks['No raw i18n keys']) {
          localeResult.ruChecks['No raw i18n keys'] = rawKeys.length > 0
            ? `FAIL: ${rawKeys.slice(0, 5).join(', ')}`
            : 'PASS';
        }
      }

      const status = leaks.length > 0 ? 'FAIL' : 'PASS';
      if (leaks.length > 0) {
        localeResult.pass = false;
        localeResult.leakage.push({ page: pg.key, leaks });
      }
      localeResult.pages[pg.key] = { status, leaks, localeCheck };

      const leakStr = leaks.length > 0 ? ` LEAKAGE: [${leaks.join(',')}]` : '';
      const verifyStr = ` (nav.activity="${localeCheck.navActivity}", stored=${localeCheck.stored})`;
      console.log(`  ${pg.key}: ${status}${leakStr}${verifyStr}`);

    } catch (err) {
      console.log(`  ${pg.key}: ERROR -- ${err.message.slice(0, 120)}`);
      localeResult.pages[pg.key] = { status: 'ERROR', error: err.message };
      localeResult.pass = false;
    }
  }

  await context.close();
  return localeResult;
}

(async () => {
  console.log(`ZAI sweep #4: Cross-locale sweep with correct /${COMPANY_PREFIX}/ URLs...`);

  const sampleIssueId = await getIssueId();
  console.log('Sample issue ID:', sampleIssueId);

  const CP = `/${COMPANY_PREFIX}`;
  const PAGES = [
    { key: 'dashboard',    path: `${CP}/dashboard`,               label: 'Dashboard' },
    { key: 'issue_detail', path: `${CP}/issues/${sampleIssueId}`, label: 'Issue Detail' },
    { key: 'inbox',        path: `${CP}/inbox`,                   label: 'Inbox' },
    { key: 'activity',     path: `${CP}/activity`,                label: 'Activity Feed' },
    { key: 'agents',       path: `${CP}/agents`,                  label: 'Agents' },
    { key: 'settings',     path: `${CP}/company/settings`,        label: 'Company Settings' },
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
  const overallVerdict = totalFail === 0 ? 'ALL PASS' : `${totalFail} FAIL`;

  const ruData = allResults.locales['ru']?.ruChecks || {};

  const leakageSection = LOCALES
    .filter(l => l !== 'en' && allResults.locales[l]?.leakage?.length > 0)
    .map(l => `**${l}**: ${allResults.locales[l].leakage.map(x => `${x.page}[${x.leaks.join(',')}]`).join(', ')}`)
    .join('\n');

  const commentBody = `## ZAI Sweep #4 -- Cross-Locale (Correct /${COMPANY_PREFIX}/ URLs)

**Overall verdict: ${totalFail === 0 ? 'ALL PASS' : `FAIL -- ${totalFail} locales with leakage`}**
*(Any English leakage = FAIL per sweep #4 spec)*

### Summary (${LOCALES.length} locales x ${PAGES.length} pages)

| Locale | Verdict | Leakage pages |
|--------|---------|---------------|
${allResults.summary.map(r => `| ${r.locale} | ${r.verdict} | ${r.leakCount} |`).join('\n')}

**${totalPass} PASS / ${totalFail} FAIL**

### Russian (ru) Acceptance Criteria
${Object.entries(ruData).map(([k, v]) => `- **${k}**: ${v}`).join('\n') || '(no Russian data)'}

### English Leakage Detail
${leakageSection || 'None detected'}

Note: This sweep uses correct /${COMPANY_PREFIX}/ company-prefixed URLs, fixing the critical URL routing bug that invalidated sweeps #1-3 for non-dashboard pages.

Screenshots in \`qa-sweep4-screenshots/\`.`;

  // Try to checkout sweep #4 and post results
  const sweep4Checkout = await apiCall('POST', `/issues/${SWEEP4_ID}/checkout`, {
    agentId: 'a6ec4085-a4e5-489c-bd10-7c46f8b62e07',
    expectedStatuses: ['blocked', 'in_progress', 'todo'],
  }).catch(e => ({ error: e.message }));

  const sweep4RunId = sweep4Checkout?.checkoutRunId || sweep4Checkout?.executionRunId;
  console.log('\nSweep #4 checkout result:', JSON.stringify(sweep4Checkout).slice(0, 100));

  if (sweep4RunId) {
    // Override RUN_ID for this call
    const postWithRun = (method, urlPath, body, runId) => {
      return new Promise((resolve, reject) => {
        const url = new URL(API_BASE + urlPath);
        const opts = {
          hostname: url.hostname, port: url.port,
          path: url.pathname + url.search, method,
          headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'x-paperclip-run-id': runId,
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
    };
    const r4 = await postWithRun('POST', `/issues/${SWEEP4_ID}/comments`, { body: commentBody }, sweep4RunId);
    console.log('Comment on sweep #4:', r4?.id || JSON.stringify(r4).slice(0, 100));
    const patch4 = await postWithRun('PATCH', `/issues/${SWEEP4_ID}`, { status: 'in_review' }, sweep4RunId);
    console.log('Sweep #4 status:', patch4?.status || JSON.stringify(patch4).slice(0, 100));
  } else {
    const r4 = await apiCall('POST', `/issues/${SWEEP4_ID}/comments`, { body: commentBody });
    console.log('Comment on sweep #4:', r4?.id || JSON.stringify(r4).slice(0, 100));
  }

  const r139 = await apiCall('POST', `/issues/${ZAI139_ID}/comments`, {
    body: `## ZAI Sweep #4 -- ${overallVerdict}\n\n${allResults.summary.map(r => `${r.locale}: ${r.verdict}`).join(' | ')}\n\nRU AC:\n${Object.entries(ruData).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '(see sweep #4)'}\n\n${leakageSection ? `Leakage:\n${leakageSection}` : 'No leakage'}`,
  });
  console.log('Comment on ZAI-139:', r139?.id || JSON.stringify(r139).slice(0, 100));

  console.log('\nSweep #4 complete.');
})().catch(err => { console.error('Sweep failed:', err); process.exit(1); });
