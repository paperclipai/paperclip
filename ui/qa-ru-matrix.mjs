/**
 * QA verification matrix: Russian locale (ru) — port 3105 Vite dev server
 * Tests visual translation correctness on the localization branch.
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const APP_BASE = 'http://127.0.0.1:3105';
const COMPANY_PREFIX = 'SDF';
const SCREENSHOT_DIR = 'qa-ru-matrix-screenshots';

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// P1 English strings that should NOT appear in Russian locale UI chrome
const P1_ENGLISH_SIGNALS = [
  'Dashboard', 'Inbox', 'Issues', 'Agents', 'Projects', 'Routines', 'Goals',
  'Costs', 'Activity', 'Settings', 'Approvals', 'Search', 'New Issue',
  'Properties', 'Priority', 'Status', 'Assignee', 'High', 'Medium', 'Low',
  'in progress', 'In Progress', 'Board',
];

// Expected Russian UI strings (positive checks)
const RU_POSITIVE = [
  { label: 'Inbox nav', terms: ['Входящие'] },
  { label: 'Activity nav', terms: ['Активность'] },
  { label: 'Settings nav', terms: ['Настройки'] },
  { label: 'Agents nav', terms: ['Агенты', 'АГЕНТЫ'] },
];

const PAGES = [
  { key: 'dashboard', path: `/${COMPANY_PREFIX}/dashboard`, label: 'Dashboard' },
  { key: 'inbox', path: `/${COMPANY_PREFIX}/inbox`, label: 'Inbox' },
  { key: 'agents', path: `/${COMPANY_PREFIX}/agents`, label: 'Agents' },
  { key: 'settings', path: `/${COMPANY_PREFIX}/company/settings`, label: 'Company Settings General' },
  { key: 'settings_access', path: `/${COMPANY_PREFIX}/company/settings/access`, label: 'Company Settings Access' },
  { key: 'settings_invites', path: `/${COMPANY_PREFIX}/company/settings/invites`, label: 'Company Settings Invites' },
  { key: 'costs', path: `/${COMPANY_PREFIX}/costs`, label: 'Costs' },
  { key: 'activity', path: `/${COMPANY_PREFIX}/activity`, label: 'Activity' },
];

(async () => {
  console.log('QA verification matrix: Russian locale (ru) — visual browser sweep');
  console.log(`Target: ${APP_BASE} with /${COMPANY_PREFIX}/ prefix`);
  console.log('');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  
  // Set Russian locale via localStorage before page loads
  await context.addInitScript(() => {
    localStorage.setItem('paperclip_language', 'ru');
  });

  const page = await context.newPage();
  const results = [];
  const allLeaks = [];

  for (const pg of PAGES) {
    console.log(`Testing: ${pg.label} (${pg.path})`);
    try {
      await page.goto(`${APP_BASE}${pg.path}`, { timeout: 30000, waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      const bodyText = await page.evaluate(() => document.body.innerText || '');
      const locale = await page.evaluate(() => localStorage.getItem('paperclip_language'));
      
      // Check for company not found
      if (bodyText.includes('Company not found') || bodyText.includes('No company matches')) {
        console.log(`  ERROR: Company not found at ${pg.path}`);
        results.push({ page: pg.label, status: 'ERROR', note: 'Company not found' });
        continue;
      }

      // Check for English leakage in UI chrome
      const pageLeaks = [];
      for (const signal of P1_ENGLISH_SIGNALS) {
        // Use word boundary check
        if (new RegExp(`\b${signal}\b`).test(bodyText)) {
          pageLeaks.push(signal);
        }
      }

      // Take screenshot
      const screenshotPath = path.join(SCREENSHOT_DIR, `${pg.key}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      // Positive checks on dashboard/inbox page
      let positiveResults = {};
      if (pg.key === 'dashboard' || pg.key === 'inbox') {
        for (const check of RU_POSITIVE) {
          positiveResults[check.label] = check.terms.some(t => bodyText.includes(t)) ? 'PASS' : 'MISS';
        }
      }

      const status = pageLeaks.length === 0 ? 'PASS' : 'FAIL';
      if (pageLeaks.length > 0) allLeaks.push({ page: pg.label, leaks: pageLeaks });

      console.log(`  ${status}${pageLeaks.length > 0 ? ' [' + pageLeaks.join(', ') + ']' : ''} (locale=${locale})`);
      if (Object.keys(positiveResults).length > 0) {
        for (const [k, v] of Object.entries(positiveResults)) {
          console.log(`    ${v}: ${k}`);
        }
      }

      results.push({ page: pg.label, status, leaks: pageLeaks, positiveResults });

    } catch (err) {
      console.log(`  ERROR: ${err.message.slice(0, 100)}`);
      results.push({ page: pg.label, status: 'ERROR', note: err.message.slice(0, 100) });
    }
  }

  await browser.close();

  console.log('\n=== SUMMARY ===');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const error = results.filter(r => r.status === 'ERROR').length;
  console.log(`PASS: ${pass} | FAIL: ${fail} | ERROR: ${error}`);
  if (allLeaks.length > 0) {
    console.log('Leakage:');
    for (const l of allLeaks) console.log(`  ${l.page}: [${l.leaks.join(', ')}]`);
  }

  // Save JSON results
  fs.writeFileSync(path.join(SCREENSHOT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\nScreenshots in ${SCREENSHOT_DIR}/`);
})().catch(err => { console.error('Sweep failed:', err); process.exit(1); });
