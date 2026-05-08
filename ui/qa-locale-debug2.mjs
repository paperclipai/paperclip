import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ 
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',  // set browser locale to Russian
  });
  const page = await context.newPage();

  // Navigate, set localStorage, reload
  await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('paperclip_language', 'ru'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const state = await page.evaluate(() => {
    return {
      stored: localStorage.getItem('paperclip_language'),
      navigatorLanguage: navigator.language,
      bodyText: document.body.innerText.slice(0, 500),
    };
  });
  console.log('locale=ru-RU + paperclip_language=ru:');
  console.log('  stored:', state.stored);
  console.log('  navigator.language:', state.navigatorLanguage);
  console.log('  body preview:', state.bodyText.replace(/\n+/g, '|').slice(0, 300));

  // Also test: use LanguageSwitcher component (simulate click)
  // Navigate to settings or wherever LanguageSwitcher is
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');

  // Look for language switcher 
  const langSwitcher = page.locator('[data-testid="language-switcher"], button:has-text("Русский"), button:has-text("English")').first();
  if (await langSwitcher.count() > 0) {
    console.log('  Language switcher found:', await langSwitcher.textContent());
  } else {
    console.log('  Language switcher: not found');
  }

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
