/**
 * ZAI-147: Cross-locale screenshot sweep #2 — FINAL
 * Uses per-locale browser contexts with addInitScript to set paperclip_language
 * before i18n initializes. Proven approach from qa-locale-verify.mjs.
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

const LOCALES = ['en', 'ru', 'de', 'el', 'es', 'pt', 'uk', 'zh'];

const EN_LEAKAGE_SIGNALS = [
  'Agents', 'Properties', 'Priority', 'Status', 'Inbox',
  'Activity', 'Settings', 'New Issue', 'Search', 'Board',
  'High', 'Medium', 'Low', 'Urgent', 'days ago', 'hours ago', 'minutes ago',
  'in progress', 'todo',
];

const RU_CHECKS = [
  { label: 'Agents heading → Агенты',       mustContain: 'Агенты' },
  { label: 'Properties → Свойства',          mustContain: 'Свойства' },
  { label: 'Board → Совет',                  mustContain: 'Совет' },
  { label: 'Priority labels in Russian',     mustContain: 'Высокий', alt: ['Средний', 'Низкий', 'Срочный'] },
];

const SCREENSHOT_DIR = 'qa-zai147-final-screenshots';
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
  const r = await apiCall('GET', `/companies/${COMPANY_ID}/issues?status=in_progress&limit=3`).catch(() => null);
  if (r?.issues?.length > 0) return r.issues[0].id;
  const r2 = await apiCall('GET', `/companies/${COMPANY_ID}/issues?limit=3`).catch(() => null);
  if (r2?.issues?.length > 0) return r2.issues[0].id;
  return null;
}

async function sweepLocale(browser, locale, pages) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Set the locale BEFORE any JS executes — i18n reads this in getInitialLanguage()
  await context.addInitScript((loc) => {
    localStorage.setItem('paperclip_language', loc);
  }, locale);

  const page = await context.newPage();
  const localeResult = { pages: {}, leakage: [], ruChecks: [], pass: true };
  const locDir = path.join(SCREENSHOT_DIR, locale);
  fs.mkdirSync(locDir, { recursive: true });

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
          await page.waitForTimeout(800);
        }
      }

      const screenshotPath = path.join(locDir, `${pg.key}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

      // Verify locale is actually applied (check nav.inbox translation)
      const localeVerified = await page.evaluate(() => {
        const inbox = document.querySelector('a[href*="inbox"]')?.textContent?.trim();
        const stored = localStorage.getItem('paperclip_language');
        return { stored, inboxText: inbox };
      });

      // English leakage
      const leaks = [];
      if (locale !== 'en') {
        for (const signal of EN_LEAKAGE_SIGNALS) {
          if (new RegExp(`\\b${signal}\\b`, 'g').test(bodyText)) leaks.push(signal);
        }
      }

      // Russian checks
      const ruResults = [];
      if (locale === 'ru') {
        for (const check of RU_CHECKS) {
          const found = bodyText.includes(check.mustContain) ||
            (check.alt && check.alt.some(a => bodyText.includes(a)));
          ruResults.push({ check: check.label, result: found ? 'PASS' : `MISS — expected: ${check.mustContain}` });
        }
        const hasRuTime = bodyText.includes('назад') || bodyText.includes('час') ||
          bodyText.includes('мин') || bodyText.includes('день') || bodyText.includes('дней');
        ruResults.push({ check: 'Relative times in Russian', result: hasRuTime ? 'PASS' : 'MISS' });
        if (pg.key === 'activity') {
          const hasRuVerbs = bodyText.includes('создал') || bodyText.includes('изменил') ||
            bodyText.includes('обновил') || bodyText.includes('закрыл') || bodyText.includes('добавил');
          ruResults.push({ check: 'Activity verbs in Russian', result: hasRuVerbs ? 'PASS' : 'MISS' });
        }
        const rawKeys = (bodyText.match(/\b[a-z_]+\.[a-z_]+\b/g) || [])
          .filter(k => k.includes('.') && k.length > 8 && !k.includes('://'));
        ruResults.push({ check: 'No raw i18n keys', result: rawKeys.length > 0 ? `FAIL — found: ${rawKeys.slice(0, 5).join(', ')}` : 'PASS' });
        localeResult.ruChecks.push(...ruResults);
      }

      const status = leaks.length > 0 ? 'WARN' : 'PASS';
      if (leaks.length > 0) localeResult.pass = false;
      localeResult.pages[pg.key] = { status, leaks, screenshot: screenshotPath, localeVerified };
      if (leaks.length > 0) localeResult.leakage.push({ page: pg.key, leaks });

      const leakStr = leaks.length > 0 ? ` LEAKAGE: [${leaks.join(',')}]` : '';
      const verifyStr = ` (nav.inbox="${localeVerified.inboxText}", stored=${localeVerified.stored})`;
      console.log(`  ${pg.key}: ${status}${leakStr}${verifyStr}`);
      if (locale === 'ru') ruResults.forEach(r => console.log(`    RU: ${r.check} → ${r.result}`));

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
  console.log('ZAI-147: Cross-locale screenshot sweep #2 — FINAL RUN (per-locale contexts)...');

  const sampleIssueId = await getIssueId();
  console.log('Sample issue ID:', sampleIssueId || 'none — skipping detail page');

  const PAGES = [
    { key: 'dashboard',    path: '/',         label: 'Dashboard' },
    { key: 'inbox',        path: '/inbox',    label: 'Inbox' },
    { key: 'agents',       path: '/agents',   label: 'Agents' },
    { key: 'activity',     path: '/activity', label: 'Activity Feed' },
    ...(sampleIssueId ? [{ key: 'issue_detail', path: `/issues/${sampleIssueId}`, label: 'Issue Detail' }] : []),
  ];

  const browser = await chromium.launch({ headless: true });

  const allResults = { locales: {}, summary: [], ruChecks: [] };

  for (const locale of LOCALES) {
    console.log(`\n=== Locale: ${locale} ===`);
    const localeResult = await sweepLocale(browser, locale, PAGES);
    allResults.locales[locale] = localeResult;
    allResults.ruChecks.push(...localeResult.ruChecks);

    const pageCount = Object.keys(localeResult.pages).length;
    const leakCount = localeResult.leakage.length;
    const verdict = localeResult.pass ? 'PASS' : (leakCount > 0 ? 'WARN' : 'FAIL');
    allResults.summary.push({ locale, verdict, pageCount, leakCount });
    console.log(`${locale}: ${verdict} (${pageCount} pages, ${leakCount} with leakage)`);
  }

  await browser.close();

  const totalPass = allResults.summary.filter(r => r.verdict === 'PASS').length;
  const totalWarn = allResults.summary.filter(r => r.verdict === 'WARN').length;
  const totalFail = allResults.summary.filter(r => r.verdict === 'FAIL').length;

  let hasLeakage = allResults.summary.some(r => r.locale !== 'en' && r.leakCount > 0);
  const overallVerdict = totalFail === 0 && totalWarn === 0 ? '✅ ALL PASS' :
    totalFail === 0 ? `⚠️ ${totalWarn} WARN (English leakage in some locales)` : `❌ ${totalFail} FAIL`;

  // Deduplicate RU checks
  const ruSeen = new Set();
  const ruSummary = allResults.ruChecks.filter(c => {
    const k = c.check + '|' + c.result;
    if (ruSeen.has(k)) return false;
    ruSeen.add(k);
    return true;
  });

  console.log('\n=== FINAL RESULTS ===');
  console.log(overallVerdict);

  const commentBody = `## ZAI-147 Cross-Locale Sweep #2 — FINAL (per-locale context method)

**Overall verdict: ${overallVerdict}**

*This run uses a fresh browser context per locale with \`addInitScript\` to set \`paperclip_language\` before i18n initializes — the proven correct testing method for this app.*

### Summary (${LOCALES.length} locales × ${PAGES.length} pages)

| Locale | Verdict | Leakage pages |
|--------|---------|---------------|
${allResults.summary.map(r => `| ${r.locale} | ${r.verdict} | ${r.leakCount} |`).join('\n')}

**${totalPass} PASS / ${totalWarn} WARN / ${totalFail} FAIL**

### Russian (ru) Acceptance Criteria
${ruSummary.length > 0 ? ruSummary.map(c => `- **${c.check}**: ${c.result}`).join('\n') : '(no Russian data collected)'}

### English Leakage Detail (non-en)
${hasLeakage ?
    LOCALES.filter(l => l !== 'en' && allResults.locales[l]?.leakage?.length > 0)
      .map(l => `**${l}**: ${allResults.locales[l].leakage.map(x => `${x.page}[${x.leaks.join(',')}]`).join(', ')}`)
      .join('\n') :
    'None detected ✅'}

Screenshots in \`qa-zai147-final-screenshots/\`.`;

  const r147 = await apiCall('POST', `/issues/${ZAI147_ID}/comments`, { body: commentBody });
  console.log('\nComment on ZAI-147:', r147?.id || JSON.stringify(r147).slice(0, 100));

  // Try ZAI-139 (parent, may be checked out by another agent)
  const r139 = await apiCall('POST', `/issues/${ZAI139_ID}/comments`, {
    body: `## ZAI-147 sweep #2 final — ${overallVerdict}\n\n${allResults.summary.map(r => `${r.locale}: ${r.verdict}`).join(' | ')}\n\nRU checks:\n${ruSummary.map(c => `- ${c.check}: ${c.result}`).join('\n')}\n\nFull results on ZAI-147.`,
  });
  console.log('Comment on ZAI-139:', r139?.id || JSON.stringify(r139).slice(0, 100));

  console.log('\nZAI-147 final sweep done.');
})().catch(err => { console.error('Sweep failed:', err); process.exit(1); });
