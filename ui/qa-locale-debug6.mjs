import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(APP_BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const state = await page.evaluate(() => {
    // Find all buttons
    const buttons = Array.from(document.querySelectorAll('button'));
    const langButtons = buttons.filter(b => 
      b.getAttribute('aria-label')?.includes('language') ||
      b.getAttribute('aria-label')?.includes('Language') ||
      b.className?.includes('language') ||
      b.textContent?.includes('English') ||
      b.textContent?.includes('Русский')
    );
    
    // Also look for .language-switcher
    const langSwitchers = document.querySelectorAll('.language-switcher, [class*="language"]');
    
    return {
      buttonCount: buttons.length,
      langButtons: langButtons.map(b => ({
        ariaLabel: b.getAttribute('aria-label'),
        className: b.className,
        text: b.textContent?.trim()?.slice(0, 50),
      })),
      langSwitcherCount: langSwitchers.length,
      allButtonAriaLabels: buttons.map(b => b.getAttribute('aria-label')).filter(Boolean),
    };
  });
  
  console.log('Buttons with "language":', JSON.stringify(state.langButtons, null, 2));
  console.log('All button aria-labels:', state.allButtonAriaLabels);
  console.log('Language switcher divs:', state.langSwitcherCount);
  console.log('Total buttons:', state.buttonCount);

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
