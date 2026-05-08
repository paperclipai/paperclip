import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

async function testLocaleNoCache(locale) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // No service workers, no cache
    serviceWorkers: 'block',
  });
  
  await context.addInitScript((loc) => {
    localStorage.setItem('paperclip_language', loc);
  }, locale);
  
  const page = await context.newPage();
  
  // Track which bundle is loaded
  let mainBundle = 'unknown';
  page.on('request', req => {
    const url = req.url();
    if (url.includes('index-') && url.endsWith('.js') && url.includes('/assets/')) {
      mainBundle = url.split('/').pop();
    }
  });
  
  // Hard-navigate to bypass any cache
  await page.goto(APP_BASE + '/?nocache=' + Date.now(), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const navInbox = document.querySelector('a[href*="inbox"]')?.textContent?.trim();
    const changeLangBtn = document.querySelector('[aria-label="Change language"]');
    const asideChildCount = document.querySelector('aside')?.children.length;
    return { 
      stored: localStorage.getItem('paperclip_language'),
      navInbox,
      changeLangBtnFound: !!changeLangBtn,
      asideChildCount,
    };
  });
  
  await browser.close();
  return { ...result, mainBundle };
}

(async () => {
  console.log('Testing en (fresh context, no cache):');
  const en = await testLocaleNoCache('en');
  console.log(JSON.stringify(en));
  
  console.log('\nTesting ru (fresh context, no cache):');
  const ru = await testLocaleNoCache('ru');
  console.log(JSON.stringify(ru));
  
  if (ru.navInbox !== 'Inbox') {
    console.log('\n✅ locale switching WORKS with fresh context!');
  } else {
    console.log('\n❌ Still English — locale issue persists in current bundle');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
