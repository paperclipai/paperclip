import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(APP_BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return 'no aside';
    
    // Count ALL children of aside
    const children = Array.from(aside.children);
    
    // Also find the change-language button in the ENTIRE document
    const allButtons = Array.from(document.querySelectorAll('button'));
    const changeLangBtn = allButtons.filter(b => b.getAttribute('aria-label') === 'Change language');
    
    // Also search entire document for .language-switcher
    const lsEl = document.querySelector('.language-switcher');
    
    return {
      asideChildCount: children.length,
      asideChildTags: children.map(c => ({ tag: c.tagName, class: c.className.slice(0, 50) })),
      changeLangButtons: changeLangBtn.map(b => ({ visible: b.offsetParent !== null, text: b.textContent?.trim() })),
      languageSwitcherDiv: lsEl ? { found: true, text: lsEl.textContent?.trim() } : { found: false },
    };
  });
  
  console.log(JSON.stringify(info, null, 2));
  
  // Take a full-page screenshot to see what's actually rendered
  await page.screenshot({ path: 'qa-full-sidebar.png', fullPage: true });
  console.log('Screenshot saved to qa-full-sidebar.png');

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
