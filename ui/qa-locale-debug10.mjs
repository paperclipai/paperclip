import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  
  await context.addInitScript((loc) => {
    localStorage.setItem('paperclip_language', loc);
  }, 'ru');
  
  const page = await context.newPage();
  
  // Track which scripts are loaded
  const loadedScripts = [];
  page.on('request', req => {
    if (req.url().includes('.js')) loadedScripts.push(req.url().split('/').pop());
  });
  
  await page.goto(APP_BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    const childCount = aside ? aside.children.length : -1;
    const navInbox = document.querySelector('a[href*="inbox"]')?.textContent?.trim();
    const languageSwitcherDiv = document.querySelector('.language-switcher');
    const changeLanguageBtn = document.querySelector('[aria-label="Change language"]');
    return {
      asideChildCount: childCount,
      navInbox,
      languageSwitcherFound: !!languageSwitcherDiv,
      changeLanguageBtnFound: !!changeLanguageBtn,
      stored: localStorage.getItem('paperclip_language'),
    };
  });
  
  const mainBundle = loadedScripts.find(s => s.startsWith('index-') && s.endsWith('.js'));
  console.log('Main bundle loaded:', mainBundle);
  console.log('Result:', JSON.stringify(result, null, 2));

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
