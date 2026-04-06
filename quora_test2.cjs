const { chromium } = require('playwright');

async function run() {
  console.log('Starting with stealth options...');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,900'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });

  // Remove webdriver property
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    // Go directly to login page
    await page.goto('https://www.quora.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    console.log('Title:', await page.title());
    console.log('URL:', page.url());

    const emailInput = await page.$('input[name="email"]');
    const passwordInput = await page.$('input[name="password"]') || await page.$('input[type="password"]');
    console.log('Email input found:', !!emailInput);
    console.log('Password input found:', !!passwordInput);

    // Get the page text
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('Body text:', bodyText);

  } catch(e) {
    console.error('Error:', e.message.slice(0,200));
  } finally {
    await page.waitForTimeout(2000);
    await browser.close();
  }
}
run().catch(console.error);
