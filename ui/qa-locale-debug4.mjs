import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({ headless: false }); // headed to see what happens
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Intercept console logs to see i18n debug output
  const logs = [];
  page.on('console', msg => {
    if (msg.text().includes('i18n') || msg.text().includes('language') || msg.text().includes('lng')) {
      logs.push(msg.text());
    }
  });

  await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('paperclip_language', 'ru'); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  // Try to read i18n state from window scope
  const i18nCheck = await page.evaluate(() => {
    try {
      // Access localStorage
      const stored = localStorage.getItem('paperclip_language');
      // Look at any injected module
      const scripts = Array.from(document.querySelectorAll('script[type="module"]'));
      // Check what language is showing in the DOM
      const navInbox = document.querySelector('a[href*="inbox"]')?.textContent?.trim();
      const navActivity = document.querySelector('a[href*="activity"]')?.textContent?.trim();
      const navSettings = document.querySelector('a[href*="settings"]')?.textContent?.trim();
      return { stored, navInbox, navActivity, navSettings };
    } catch(e) { return { error: e.message }; }
  });
  
  console.log('i18n check:', JSON.stringify(i18nCheck));
  console.log('Captured logs:', logs.slice(0, 10));

  await page.screenshot({ path: 'qa-debug-headed.png' });
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
