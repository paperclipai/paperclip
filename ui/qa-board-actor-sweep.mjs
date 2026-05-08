import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const BASE_URL = 'http://127.0.0.1:3105';
const LOCALES = ['en', 'ru', 'de', 'el', 'es', 'pt', 'uk', 'zh'];
const PAGES = [
  '/ZAI/dashboard',
  '/ZAI/activity',
  '/ZAI/agents',
  '/ZAI/inbox/mine'
];

const COMPANY = 'ZAI';

const results = {
  timestamp: new Date().toISOString(),
  totalTests: 0,
  passed: 0,
  failed: 0,
  localeResults: {}
};

async function setLocale(page, locale) {
  // Open settings to change locale
  await page.goto(`${BASE_URL}/${COMPANY}/settings`);
  await page.waitForLoadState('networkidle');
  
  // Find and click language selector
  const langButton = await page.locator('[data-testid="language-selector"]').first();
  if (await langButton.isVisible()) {
    await langButton.click();
    await page.waitForTimeout(300);
    
    // Select the locale option
    const localeOption = await page.locator(`[data-value="${locale}"]`).first();
    if (await localeOption.isVisible()) {
      await localeOption.click();
      await page.waitForTimeout(500);
    }
  }
}

async function scanPageForBoardText(page, locale) {
  const content = await page.content();
  // Look for hardcoded "Board" in activity, member displays, etc.
  // In non-en locales, should NOT appear
  
  let found = [];
  
  // Check for common "Board" patterns
  const patterns = [
    /<span[^>]*>Board<\/span>/gi,
    />Board</gi,
    /Board<\//gi,
    /"Board"/gi,
  ];
  
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      const matches = content.match(pattern) || [];
      found = found.concat(matches);
    }
  }
  
  return found;
}

async function runSweep() {
  const browser = await chromium.launch();
  
  for (const locale of LOCALES) {
    console.log(`\nTesting locale: ${locale}`);
    results.localeResults[locale] = { pages: {}, status: 'pending' };
    
    const context = await browser.createContext({ locale });
    const page = await context.newPage();
    
    try {
      // Set the locale
      if (locale !== 'en') {
        await setLocale(page, locale);
      }
      
      // Test each page
      for (const testPage of PAGES) {
        results.totalTests++;
        const url = `${BASE_URL}/${COMPANY}${testPage}`;
        
        try {
          await page.goto(url, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1000);
          
          const found = await scanPageForBoardText(page, locale);
          
          if (locale === 'en') {
            // English should have Board
            results.localeResults[locale].pages[testPage] = { status: 'PASS', note: 'English baseline' };
            results.passed++;
          } else {
            if (found.length === 0) {
              results.localeResults[locale].pages[testPage] = { status: 'PASS', hardcodedCount: 0 };
              results.passed++;
            } else {
              results.localeResults[locale].pages[testPage] = { status: 'FAIL', hardcodedCount: found.length, samples: found.slice(0, 3) };
              results.failed++;
            }
          }
        } catch (e) {
          results.localeResults[locale].pages[testPage] = { status: 'ERROR', error: e.message };
          results.failed++;
        }
      }
      
      results.localeResults[locale].status = 'complete';
    } finally {
      await context.close();
    }
  }
  
  await browser.close();
  return results;
}

const results_final = await runSweep();
console.log('\n=== SWEEP RESULTS ===');
console.log(JSON.stringify(results_final, null, 2));

writeFileSync('qa-board-actor-sweep-results.json', JSON.stringify(results_final, null, 2));
console.log('\nResults written to: qa-board-actor-sweep-results.json');
