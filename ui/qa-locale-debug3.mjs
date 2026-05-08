import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(APP_BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('paperclip_language', 'ru'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Try to access i18n through React's internals
  const i18nState = await page.evaluate(() => {
    // Try to find i18n instance via React fiber
    try {
      // Look for __reactFiber or similar
      const el = document.querySelector('#root') || document.querySelector('[data-reactroot]');
      if (!el) return { error: 'no root element' };
      
      // Try window globals that React apps often expose
      const keys = Object.keys(window).filter(k => k.includes('i18n') || k.includes('I18n'));
      return { 
        windowKeys: keys,
        reactRoot: el ? el.tagName : 'none',
        localStorage_key: localStorage.getItem('paperclip_language'),
      };
    } catch(e) {
      return { error: e.message };
    }
  });
  console.log('i18n state:', JSON.stringify(i18nState));

  // Also check if the nav items are actually translated in the DOM
  const navItems = await page.evaluate(() => {
    // Get all nav links text content
    const links = Array.from(document.querySelectorAll('nav a, aside a, [role="navigation"] a'));
    return links.map(l => l.textContent?.trim()).filter(Boolean).slice(0, 20);
  });
  console.log('Nav link texts:', navItems);

  // Check what the sidebar renders for inbox
  const inboxNavText = await page.evaluate(() => {
    // Look for the inbox link specifically
    const links = Array.from(document.querySelectorAll('a[href*="inbox"]'));
    return links.map(l => ({ href: l.getAttribute('href'), text: l.textContent?.trim() }));
  });
  console.log('Inbox links:', inboxNavText);

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
