/**
 * ZAI Sweep #6: Board actor + nav.search fix verification
 * Tests commit fdfbcbc2: Board actor i18n + nav.search for el/es/pt/uk/zh
 * Build: index-BTnO0wUZ.js (commits through 874d20b2)
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
const SWEEP6_ID = '86a183b8-24d7-4975-9ae0-faf6a66c65e4';
const ZAI139_ID = 'e1e0e7df-7a38-45a0-9434-95abc7e0f99e';
const SWEEP6_RUN_ID = '0be95457-0ad7-45b8-a989-b50ae6df39a4';
const SCREENSHOT_DIR = 'qa-sweep6-screenshots';

const LOCALES = ['en', 'ru', 'de', 'el', 'es', 'pt', 'uk', 'zh'];

const BOARD_TRANSLATION = {
  ru: 'Совет',
  de: 'Tafel',
  el: 'Ταμπλό',
  es: 'Tablero',
  pt: 'Quadro',
  uk: 'Дошка',
  zh: '看板',
};

const SEARCH_TRANSLATION = {
  de: 'Suche',
  el: 'Αναζήτηση',
  es: 'Buscar',
  pt: 'Pesquisar',
  uk: 'Пошук',
  zh: '搜索',
};

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function apiCall(method, urlPath, body, runId) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + urlPath);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'x-paperclip-run-id': runId || RUN_ID,
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

async function getSampleIssueId() {
  const r = await apiCall('GET', `/companies/${COMPANY_ID}/issues?status=in_progress&limit=10`).catch(() => null);
  const issues = r?.issues || (Array.isArray(r) ? r : []);
  const nonEn = issues.find(i => i.title && !/^(ZAI|Sweep|Browser|QA)/.test(i.title));
  if (nonEn) return nonEn.id;
  if (issues.length > 0) return issues[0].id;
  return 'e1e0e7df-7a38-45a0-9434-95abc7e0f99e';
}

(async () => {
  console.log('ZAI Sweep #6: Board actor + nav.search fix verification');
  console.log('Build: index-Bhtev28c.js (874d20b2)');
  console.log('');

  const sampleIssueId = await getSampleIssueId();
  console.log('Sample issue ID:', sampleIssueId);

  const CP = '/' + COMPANY_PREFIX;
  const PAGES = [
    { key: 'dashboard', path: CP + '/dashboard' },
    { key: 'activity',  path: CP + '/activity' },
    { key: 'inbox',     path: CP + '/inbox/mine' },
    { key: 'agents',    path: CP + '/agents' },
  ];

  const browser = await chromium.launch({ headless: true });
  const results = {};
  const summary = [];

  for (const locale of LOCALES) {
    console.log('\n=== Locale: ' + locale + ' ===');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((loc) => {
      localStorage.setItem('paperclip_language', loc);
    }, locale);

    const page = await context.newPage();
    const locDir = path.join(SCREENSHOT_DIR, locale);
    fs.mkdirSync(locDir, { recursive: true });
    const locResult = { pages: {}, boardLeakage: [], searchLeakage: [], boardFound: false, pass: true };

    for (const pg of PAGES) {
      try {
        await page.goto(APP_BASE + pg.path, { timeout: 25000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

        if (bodyText.includes('Company not found') || bodyText.includes('No company matches')) {
          console.log('  ' + pg.key + ': ERROR company not found');
          locResult.pages[pg.key] = 'ERROR';
          locResult.pass = false;
          continue;
        }

        await page.screenshot({ path: path.join(locDir, pg.key + '.png'), fullPage: false });

        const pageIssues = [];

        if (locale !== 'en') {
          const boardCount = (bodyText.match(/\bBoard\b/g) || []).length;
          if (boardCount > 0) {
            locResult.boardLeakage.push({ page: pg.key, count: boardCount });
            locResult.pass = false;
            pageIssues.push('Board(x' + boardCount + ')');
          }

          const hasSearchFix = Object.keys(SEARCH_TRANSLATION).includes(locale);
          if (hasSearchFix && /\bSearch\b/.test(bodyText)) {
            locResult.searchLeakage.push(pg.key);
            locResult.pass = false;
            pageIssues.push('Search');
          }

          const boardTrans = BOARD_TRANSLATION[locale];
          if (boardTrans && bodyText.includes(boardTrans)) {
            locResult.boardFound = true;
          }
        }

        const status = pageIssues.length === 0 ? 'PASS' : 'FAIL[' + pageIssues.join(',') + ']';
        locResult.pages[pg.key] = status;
        console.log('  ' + pg.key + ': ' + status);

      } catch (err) {
        console.log('  ' + pg.key + ': ERROR -- ' + err.message.slice(0, 80));
        locResult.pages[pg.key] = 'ERROR';
        locResult.pass = false;
      }
    }

    await context.close();
    results[locale] = locResult;
    const verdict = locResult.pass ? 'PASS' : 'FAIL';
    summary.push({ locale, verdict, boardLeakage: locResult.boardLeakage, searchLeakage: locResult.searchLeakage, boardFound: locResult.boardFound });
    console.log(locale + ': ' + verdict);
  }

  await browser.close();

  const totalPass = summary.filter(r => r.verdict === 'PASS').length;
  const totalFail = summary.filter(r => r.verdict === 'FAIL').length;

  const boardTransLines = Object.entries(BOARD_TRANSLATION)
    .map(([loc, term]) => '- **' + loc + '**: ' + (results[loc]?.boardFound ? '✅ "' + term + '" found' : '⚠️ "' + term + '" not seen (may need activity with Board actor)'))
    .join('\n');

  const searchTransLines = Object.entries(SEARCH_TRANSLATION)
    .map(([loc, term]) => {
      const hasLeak = results[loc]?.searchLeakage?.length > 0;
      return '- **' + loc + '**: ' + (hasLeak ? '❌ "Search" still visible' : '✅ no "Search" leakage') + ' (expected: "' + term + '")';
    }).join('\n');

  const leakageLines = summary
    .filter(r => r.verdict !== 'PASS')
    .map(r => {
      const parts = [];
      if (r.boardLeakage.length > 0) parts.push('Board: ' + r.boardLeakage.map(x => x.page + '(' + x.count + ')').join(', '));
      if (r.searchLeakage.length > 0) parts.push('Search: ' + r.searchLeakage.join(', '));
      return '**' + r.locale + '**: ' + parts.join('; ');
    }).join('\n');

  const overallVerdict = totalFail === 0 ? 'ALL PASS' : 'FAIL -- ' + totalFail + ' locales';

  const commentBody = '## ZAI Sweep #6 -- Board Actor + nav.search Fix Verification\n\n' +
    '**Build:** `index-Bhtev28c.js` (HEAD 874d20b2, includes fdfbcbc2)\n\n' +
    '**Overall: ' + (totalFail === 0 ? 'ALL PASS' : 'FAIL -- ' + totalFail + ' locales') + '**\n\n' +
    '### Summary (' + LOCALES.length + ' locales x ' + PAGES.length + ' pages)\n\n' +
    '| Locale | Verdict |\n|--------|----------|\n' +
    summary.map(r => '| ' + r.locale + ' | ' + r.verdict + ' |').join('\n') + '\n\n' +
    '**' + totalPass + ' PASS / ' + totalFail + ' FAIL**\n\n' +
    '### Board Actor Translation Check\n' + boardTransLines + '\n\n' +
    '### nav.search Fix Check (el/es/pt/uk/zh)\n' + searchTransLines + '\n\n' +
    (leakageLines ? '### Leakage Detail\n' + leakageLines + '\n\n' : '') +
    'Screenshots in `qa-sweep6-screenshots/`.';

  console.log('\n=== POSTING RESULTS ===');

  const r6 = await apiCall('POST', '/issues/' + SWEEP6_ID + '/comments', { body: commentBody }, SWEEP6_RUN_ID);
  console.log('Comment on sweep #6:', r6?.id || JSON.stringify(r6).slice(0, 80));

  if (totalFail === 0) {
    const patch = await apiCall('PATCH', '/issues/' + SWEEP6_ID, { status: 'in_review' }, SWEEP6_RUN_ID);
    console.log('Sweep #6 -> in_review:', patch?.status);
  }

  const shortBody = '## ZAI Sweep #6 -- ' + overallVerdict + '\n\nBuild: index-BTnO0wUZ.js (fdfbcbc2+)\n\n' +
    summary.map(r => r.locale + ': ' + r.verdict).join(' | ') + '\n\n' +
    'Board actor: ' + Object.keys(BOARD_TRANSLATION).map(l => l + ':' + (results[l]?.boardFound ? '✅' : '⚠️')).join(' ') + '\n' +
    'nav.search: ' + Object.keys(SEARCH_TRANSLATION).map(l => l + ':' + (results[l]?.searchLeakage?.length > 0 ? '❌' : '✅')).join(' ');

  const r139 = await apiCall('POST', '/issues/' + ZAI139_ID + '/comments', { body: shortBody });
  console.log('Comment on ZAI-139:', r139?.id || JSON.stringify(r139).slice(0, 80));

  console.log('\nSweep #6 complete.');
})().catch(err => { console.error('Sweep failed:', err); process.exit(1); });
