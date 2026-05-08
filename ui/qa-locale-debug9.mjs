import { chromium } from '@playwright/test';

const APP_BASE = 'http://127.0.0.1:3100';

async function testLocale(locale) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  
  // Inject localStorage BEFORE any page JS executes
  await context.addInitScript((loc) => {
    localStorage.setItem('paperclip_language', loc);
  }, locale);
  
  const page = await context.newPage();
  await page.goto(APP_BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const navInbox = document.querySelector('a[href*="inbox"]')?.textContent?.trim();
    const navActivity = document.querySelector('a[href*="activity"]')?.textContent?.trim();
    const navSettings = document.querySelector('a[href*="settings"]')?.textContent?.trim();
    const stored = localStorage.getItem('paperclip_language');
    const bodySnippet = document.body.innerText.slice(0, 300);
    return { stored, navInbox, navActivity, navSettings, bodySnippet };
  });
  
  await browser.close();
  return result;
}

(async () => {
  console.log('Testing locale=en:');
  const en = await testLocale('en');
  console.log('  stored:', en.stored, '| inbox:', en.navInbox, '| activity:', en.navActivity);
  
  console.log('Testing locale=ru:');
  const ru = await testLocale('ru');
  console.log('  stored:', ru.stored, '| inbox:', ru.navInbox, '| activity:', ru.navActivity);
  
  console.log('Testing locale=de:');
  const de = await testLocale('de');
  console.log('  stored:', de.stored, '| inbox:', de.navInbox, '| activity:', de.navActivity);
  
  if (ru.navInbox !== en.navInbox) {
    console.log('\n✅ addInitScript approach WORKS — locale switching confirmed!');
  } else {
    console.log('\n❌ addInitScript approach does NOT change nav items');
    console.log('RU body:', ru.bodySnippet.slice(0, 200));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
