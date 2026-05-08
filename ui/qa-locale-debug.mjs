import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Navigate first
  await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Check initial locale
  const initialLocale = await page.evaluate(() => {
    return {
      stored: localStorage.getItem('paperclip_language'),
      i18nLng: window.i18n?.language ?? 'n/a',
      bodySnippet: document.body.innerText.slice(0, 200),
    };
  });
  console.log('Before setLocale:', JSON.stringify(initialLocale, null, 2));

  // Set to Russian
  await page.evaluate(() => { localStorage.setItem('paperclip_language', 'ru'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const afterReload = await page.evaluate(() => {
    return {
      stored: localStorage.getItem('paperclip_language'),
      bodySnippet: document.body.innerText.slice(0, 400),
    };
  });
  console.log('After setLocale+reload:', JSON.stringify(afterReload, null, 2));

  // Also try i18n changeLanguage
  await page.evaluate(() => {
    // reset to en first
    localStorage.setItem('paperclip_language', 'en');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // Now change language via i18n directly
  const i18nChange = await page.evaluate(async () => {
    // Try to access i18n from window
    const i18nModule = window.__i18n_instance__;
    if (i18nModule) {
      await i18nModule.changeLanguage('ru');
      return { method: 'window.__i18n_instance__', bodySnippet: document.body.innerText.slice(0, 300) };
    }
    return { method: 'not found', bodySnippet: document.body.innerText.slice(0, 300) };
  });
  console.log('i18n direct change:', JSON.stringify(i18nChange, null, 2));

  await page.screenshot({ path: 'qa-debug-screenshot.png' });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
