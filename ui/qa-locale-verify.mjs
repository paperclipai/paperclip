import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

async function testLocale(locale) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  
  await context.addInitScript((loc) => { localStorage.setItem('paperclip_language', loc); }, locale);
  
  const page = await context.newPage();
  let bundle = 'unknown';
  page.on('request', req => {
    if (req.url().includes('index-') && req.url().endsWith('.js') && req.url().includes('/assets/')) {
      bundle = req.url().split('/').pop();
    }
  });
  
  await page.goto(APP_BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => ({
    stored: localStorage.getItem('paperclip_language'),
    navInbox: document.querySelector('a[href*="inbox"]')?.textContent?.trim(),
    asideChildCount: document.querySelector('aside')?.children.length,
    changeLangBtnFound: !!document.querySelector('[aria-label="Change language"]'),
  }));
  
  await browser.close();
  return { ...result, bundle };
}

(async () => {
  const en = await testLocale('en');
  console.log('en:', JSON.stringify(en));
  const ru = await testLocale('ru');
  console.log('ru:', JSON.stringify(ru));
  
  console.log(ru.navInbox !== 'Inbox' ? '✅ LOCALE SWITCHING WORKS!' : '❌ Still English nav');
  console.log('LanguageSwitcher found:', ru.changeLangBtnFound);
})().catch(e => { console.error(e.message); process.exit(1); });
