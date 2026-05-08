import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(APP_BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Method 1: Use React's i18n.changeLanguage via a custom event or direct module access
  // The app exports setLanguage from i18n.ts, but we can't import it in eval
  // Try dispatching a storage event to simulate localStorage change from another tab
  const result1 = await page.evaluate(() => {
    // Simulate what setLanguage() does: change language directly via the i18n singleton
    // Try to find it via React's __SECRET_INTERNALS or similar
    try {
      // First, just check the nav
      const navText = document.querySelector('a[href*="inbox"]')?.textContent?.trim();
      
      // Try to change language by triggering a storage event
      localStorage.setItem('paperclip_language', 'ru');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'paperclip_language',
        newValue: 'ru',
        oldValue: null,
        storageArea: localStorage,
      }));
      
      return { before: navText, stored: localStorage.getItem('paperclip_language') };
    } catch(e) { return { error: e.message }; }
  });
  console.log('Before:', result1);
  await page.waitForTimeout(500);

  const navAfterEvent = await page.evaluate(() => document.querySelector('a[href*="inbox"]')?.textContent?.trim());
  console.log('After storage event:', navAfterEvent);

  // Method 2: Check if the app's i18n module is accessible via __webpack_modules__ or Vite's __vite_ssr_import_xxx
  const viteModules = await page.evaluate(() => {
    try {
      // Vite exposes __vite_plugin_react_preamble_installed__ and similar
      const viteKeys = Object.keys(window).filter(k => k.startsWith('__vite'));
      return { viteKeys };
    } catch(e) { return { error: e.message }; }
  });
  console.log('Vite globals:', viteModules);

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
