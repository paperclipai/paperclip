const { chromium } = require('playwright');

async function run() {
  console.log('Starting...');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto('https://www.quora.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('Title:', await page.title());
    console.log('URL:', page.url());
    const emailInput = await page.$('input[name="email"]');
    console.log('Email input found:', !!emailInput);
  } catch(e) {
    console.error('Error:', e.message.slice(0,200));
  } finally {
    await browser.close();
  }
}
run().catch(console.error);
