/**
 * ZAI-145: Cross-locale screenshot sweep — i18n R3
 * 8 locales × 8 pages, special Russian AC checks
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const API_BASE = 'http://127.0.0.1:3100/api';
const APP_BASE = 'http://127.0.0.1:3100';
const TOKEN = process.env.PAPERCLIP_API_KEY;
const RUN_ID = process.env.PAPERCLIP_RUN_ID;
const COMPANY_ID = '13e61789-5895-451b-95a8-a7457a310c9e';
const ZAI145_ID = 'ce5821a1-38a6-40fb-989f-26cd66d305cf';
const ZAI139_ID = null; // will look up

const LOCALES = ['en', 'ru', 'de', 'es', 'fr', 'it', 'pt', 'zh'];

// English strings that should NOT appear in non-English locales (UI-visible labels)
const EN_LEAKAGE_SIGNALS = [
  'Agents', 'Properties', 'Priority', 'Status', 'Inbox',
  'Activity', 'Settings', 'New Issue', 'Search', 'Board',
  'High', 'Medium', 'Low', 'Urgent', 'days ago', 'hours ago', 'minutes ago',
];

// Russian-specific acceptance criteria
const RU_CHECKS = [
  { label: 'Agents heading → Агент', mustContain: 'Агент', mustNotContain: null },
  { label: 'Board → Совет',          mustContain: 'Совет', mustNotContain: null },
  { label: 'Properties → Свойства',  mustContain: 'Свойства', mustNotContain: null },
];

const SCREENSHOT_DIR = 'qa-zai145-screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'x-paperclip-run-id': RUN_ID,
        'Content-Type': 'application/json',
      }
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

async function setLocale(page, locale) {
  await page.evaluate((loc) => {
    localStorage.setItem('i18nextLng', loc);
  }, locale);
}

async function getIssueId() {
  // Get any open issue to use for detail page
  const issues = await apiCall('GET', `/companies/${COMPANY_ID}/issues?status=in_progress&limit=3`).catch(() => null);
  if (issues && issues.issues && issues.issues.length > 0) return issues.issues[0].id;
  const issues2 = await apiCall('GET', `/companies/${COMPANY_ID}/issues?limit=3`).catch(() => null);
  if (issues2 && issues2.issues && issues2.issues.length > 0) return issues2.issues[0].id;
  return null;
}

const results = { locales: {}, englishLeakage: [], ruChecks: [], summary: [] };

async function runSweep() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Get a sample issue ID for the detail page
  const sampleIssueId = await getIssueId();
  console.log('Sample issue ID:', sampleIssueId || 'none — skipping detail page');

  const PAGES = [
    { key: 'dashboard',     path: '/',                    label: 'Dashboard' },
    { key: 'inbox',         path: '/inbox',               label: 'Inbox' },
    { key: 'agents',        path: '/agents',              label: 'Agents' },
    { key: 'activity',      path: '/activity',            label: 'Activity Feed' },
    ...(sampleIssueId ? [{ key: 'issue_detail', path: `/issues/${sampleIssueId}`, label: 'Issue Detail' }] : []),
  ];

  for (const locale of LOCALES) {
    console.log(`\n=== Locale: ${locale} ===`);
    results.locales[locale] = { pages: {}, leakage: [], pass: true };
    const locDir = path.join(SCREENSHOT_DIR, locale);
    fs.mkdirSync(locDir, { recursive: true });

    for (const pg of PAGES) {
      try {
        // Navigate to page
        await page.goto(`${APP_BASE}${pg.path}`, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await setLocale(page, locale);
        await page.reload({ timeout: 15000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        // Special: open inbox filters dropdown if on inbox page
        if (pg.key === 'inbox') {
          const filterBtn = page.locator('[data-testid="filters-btn"], button:has-text("Filter"), button:has-text("Фильтр")').first();
          if (await filterBtn.count() > 0) {
            await filterBtn.click().catch(() => {});
            await page.waitForTimeout(800);
          }
        }

        // Special: open command palette on last page
        if (pg.key === 'dashboard') {
          // Also take a command palette screenshot
          await page.keyboard.press('Meta+k');
          await page.waitForTimeout(600);
          const cmdPalette = page.locator('[data-testid="command-palette"], [role="dialog"][aria-label*="command"], [cmdk-root]').first();
          if (await cmdPalette.count() > 0) {
            const cpPath = path.join(locDir, 'command_palette.png');
            await page.screenshot({ path: cpPath });
            console.log(`  command_palette: screenshot saved`);
            results.locales[locale].pages['command_palette'] = { status: 'SCREENSHOT' };
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
          await page.reload({ timeout: 10000, waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1500);
        }

        const screenshotPath = path.join(locDir, `${pg.key}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        // Get visible text
        const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

        // Check for English leakage (only in non-English locales)
        const leaks = [];
        if (locale !== 'en') {
          for (const signal of EN_LEAKAGE_SIGNALS) {
            // Look for isolated English words (not part of URLs, IDs, etc.)
            const regex = new RegExp(`\\b${signal}\\b`, 'g');
            if (regex.test(bodyText)) {
              leaks.push(signal);
            }
          }
        }

        // Russian-specific checks
        const ruResults = [];
        if (locale === 'ru') {
          for (const check of RU_CHECKS) {
            if (check.mustContain && bodyText.includes(check.mustContain)) {
              ruResults.push({ check: check.label, result: 'PASS' });
            } else if (check.mustContain) {
              ruResults.push({ check: check.label, result: 'MISS', expected: check.mustContain });
            }
          }
          // Check relative time format
          const hasRuTime = bodyText.includes('назад') || bodyText.includes('час') || bodyText.includes('мин');
          ruResults.push({ check: 'Relative times in Russian', result: hasRuTime ? 'PASS' : 'MISS — no Russian time strings found' });

          // Check no raw i18n keys (keys look like "sidebar.new_issue" or "access_roles.board")
          const i18nKeyPattern = /\b[a-z_]+\.[a-z_]+\b/g;
          const rawKeys = (bodyText.match(i18nKeyPattern) || []).filter(k => k.includes('.') && k.length > 8 && !k.includes('://'));
          if (rawKeys.length > 0) {
            ruResults.push({ check: 'No raw i18n keys', result: `FAIL — found: ${rawKeys.slice(0,5).join(', ')}` });
          } else {
            ruResults.push({ check: 'No raw i18n keys', result: 'PASS' });
          }
        }

        const status = leaks.length > 0 ? 'WARN' : 'PASS';
        if (leaks.length > 0) results.locales[locale].pass = false;
        results.locales[locale].pages[pg.key] = { status, leaks, screenshot: screenshotPath };
        if (leaks.length > 0) results.locales[locale].leakage.push({ page: pg.key, leaks });
        if (locale === 'ru') results.ruChecks.push(...ruResults);

        const leakStr = leaks.length > 0 ? ` LEAKAGE: [${leaks.join(',')}]` : '';
        console.log(`  ${pg.key}: ${status}${leakStr}`);
        if (locale === 'ru') ruResults.forEach(r => console.log(`    RU check: ${r.check} → ${r.result}`));

      } catch (err) {
        console.log(`  ${pg.key}: ERROR — ${err.message.slice(0, 100)}`);
        results.locales[locale].pages[pg.key] = { status: 'ERROR', error: err.message };
        results.locales[locale].pass = false;
      }
    }
  }

  await browser.close();

  // Build summary
  for (const locale of LOCALES) {
    const loc = results.locales[locale];
    const pageCount = Object.keys(loc.pages).length;
    const leakCount = loc.leakage.length;
    const verdict = loc.pass ? 'PASS' : (leakCount > 0 ? 'WARN' : 'FAIL');
    results.summary.push({ locale, verdict, pageCount, leakCount });
    console.log(`\n${locale}: ${verdict} (${pageCount} pages, ${leakCount} pages with leakage)`);
  }

  return results;
}

async function uploadAttachment(filename, content) {
  const boundary = '----FormBoundary' + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: 3100,
      path: '/api/attachments',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'x-paperclip-run-id': RUN_ID,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('ZAI-145: Cross-locale screenshot sweep starting...');
  const results = await runSweep();

  // Build report
  const report = [];
  report.push('# ZAI-145 Cross-Locale Screenshot Sweep — i18n R3\n');
  report.push('## Summary\n');
  const summaryTable = results.summary.map(r =>
    `| ${r.locale} | ${r.verdict} | ${r.pageCount} pages | ${r.leakCount} with leakage |`
  ).join('\n');
  report.push('| Locale | Verdict | Pages | Leakage |\n|--------|---------|-------|---------|');
  report.push(summaryTable);

  const totalPass = results.summary.filter(r => r.verdict === 'PASS').length;
  const totalWarn = results.summary.filter(r => r.verdict === 'WARN').length;
  const totalFail = results.summary.filter(r => r.verdict === 'FAIL').length;

  report.push(`\n**Overall: ${totalPass} PASS / ${totalWarn} WARN / ${totalFail} FAIL**\n`);

  report.push('## Russian Locale (ru) Acceptance Criteria\n');
  results.ruChecks.forEach(c => {
    report.push(`- **${c.check}**: ${c.result}`);
  });

  report.push('\n## English Leakage Details\n');
  let hasLeakage = false;
  for (const locale of LOCALES) {
    if (locale === 'en') continue;
    const loc = results.locales[locale];
    if (loc.leakage && loc.leakage.length > 0) {
      hasLeakage = true;
      report.push(`### ${locale}`);
      loc.leakage.forEach(l => {
        report.push(`- **${l.page}**: leaked strings: \`${l.leaks.join('`, `')}\``);
      });
    }
  }
  if (!hasLeakage) report.push('No English leakage detected in any non-English locale. ✅');

  report.push('\n## Screenshots\n');
  report.push(`Screenshots saved to \`${SCREENSHOT_DIR}/\` organized by locale.`);

  const reportText = report.join('\n');
  console.log('\n' + reportText);
  fs.writeFileSync('qa-zai145-report.md', reportText);

  // Post comment to ZAI-145
  const overallVerdict = totalFail === 0 && totalWarn === 0 ? '✅ ALL PASS' :
    totalFail === 0 ? `⚠️ ${totalWarn} WARN (English leakage in some locales)` : `❌ ${totalFail} FAIL`;

  const commentBody = `## ZAI-145 Cross-Locale Screenshot Sweep — COMPLETE

**Overall verdict: ${overallVerdict}**

### Summary (${LOCALES.length} locales × ${Object.keys(results.locales[LOCALES[0]]?.pages || {}).length} pages)

| Locale | Verdict | Leakage pages |
|--------|---------|---------------|
${results.summary.map(r => `| ${r.locale} | ${r.verdict} | ${r.leakCount} |`).join('\n')}

### Russian (ru) Acceptance Criteria
${results.ruChecks.map(c => `- **${c.check}**: ${c.result}`).join('\n')}

### English Leakage (non-en locales)
${hasLeakage ?
    LOCALES.filter(l => l !== 'en' && results.locales[l]?.leakage?.length > 0)
      .map(l => `**${l}**: ${results.locales[l].leakage.map(x => `${x.page}[${x.leaks.join(',')}]`).join(', ')}`)
      .join('\n') :
    'None detected ✅'}

Screenshots organized by locale in \`qa-zai145-screenshots/\`.`;

  const commentResp = await apiCall('POST', `/issues/${ZAI145_ID}/comments`, { body: commentBody });
  console.log('\nComment posted:', commentResp?.id || commentResp);

  // If English leakage found, also comment on ZAI-139
  if (hasLeakage) {
    // Find ZAI-139
    const zai139 = await apiCall('GET', `/companies/${COMPANY_ID}/issues/by-identifier/ZAI-139`).catch(() => null);
    if (zai139 && zai139.id) {
      const leakageComment = `## ZAI-145 found English leakage in R3 sweep

The following non-English locales still show English strings in the UI:
${LOCALES.filter(l => l !== 'en' && results.locales[l]?.leakage?.length > 0)
  .map(l => `- **${l}**: ${results.locales[l].leakage.map(x => `${x.page}: [${x.leaks.join(', ')}]`).join('; ')}`)
  .join('\n')}

These are candidates for follow-up fixes.`;
      await apiCall('POST', `/issues/${zai139.id}/comments`, { body: leakageComment });
      console.log('Filed leakage comment on ZAI-139');
    }
  }

  // Mark ZAI-145 done
  const patchResp = await apiCall('PATCH', `/issues/${ZAI145_ID}`, { status: 'done' });
  console.log('ZAI-145 status patch:', patchResp?.status || patchResp);

  console.log('\nZAI-145 sweep complete.');
})().catch(err => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
