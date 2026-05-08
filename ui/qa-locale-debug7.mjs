import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(APP_BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const state = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return { asideFound: false };
    
    // Get all elements with text content at bottom of sidebar
    const allText = aside.innerText;
    const allButtons = Array.from(aside.querySelectorAll('button'));
    const lastDiv = aside.lastElementChild;
    
    return {
      asideFound: true,
      asideButtonCount: allButtons.length,
      asideButtonLabels: allButtons.map(b => ({ label: b.getAttribute('aria-label'), text: b.textContent?.trim()?.slice(0, 30), class: b.className?.slice(0, 50) })),
      asideInnerTextSnippet: allText.slice(-200),
      lastDivHTML: lastDiv?.outerHTML?.slice(0, 300),
    };
  });
  console.log(JSON.stringify(state, null, 2));

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
