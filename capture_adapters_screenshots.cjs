const puppeteer = require('puppeteer-core');
const chromium = require('chromium');
const fs = require('fs');
const path = require('path');

const screenshotDir = path.join(process.cwd(), 'screenshots_adapters');

async function captureScreenshots() {
  // Ensure screenshot directory exists
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  const browser = await puppeteer.launch({
    executablePath: chromium.executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    // Navigate to the adapters page
    console.log('Navigating to http://127.0.0.1:3105/instance/settings/adapters');
    await page.goto('http://127.0.0.1:3105/instance/settings/adapters', {
      waitUntil: 'networkidle2'
    });

    // Wait a bit for the page to fully load
    await page.waitForTimeout(2000);

    // Take screenshot of initial page
    console.log('Taking screenshot 1: Main page');
    await page.screenshot({
      path: path.join(screenshotDir, '01_main_page.png'),
      fullPage: true
    });

    // Find all tabs
    const tabs = await page.$$('[role="tab"], .tab-button, [data-testid*="tab"]');
    console.log(`Found ${tabs.length} potential tabs`);

    // Also try to find tabs by class names commonly used in web apps
    const tabElements = await page.evaluate(() => {
      const elements = [];
      // Try common tab selectors
      const selectors = [
        '[role="tab"]',
        '.nav-tabs > li',
        '.tab-content > div',
        '[class*="tab"]',
        '[data-test*="tab"]'
      ];

      for (const selector of selectors) {
        const found = document.querySelectorAll(selector);
        found.forEach(el => {
          if (el.offsetParent !== null) { // Check if visible
            const text = el.textContent?.trim() || el.getAttribute('data-test') || el.className;
            if (text && text.length > 0) {
              elements.push({
                selector: selector,
                text: text.substring(0, 100),
                className: el.className,
                id: el.id
              });
            }
          }
        });
      }
      return elements;
    });

    console.log('Tab elements found:', tabElements.slice(0, 5));

    // Click through tabs and capture screenshots
    let tabCount = 1;

    // Try clicking on each tab element found
    const clickableTabs = await page.$$('[role="tab"][tabindex="0"], [role="tab"]:not([tabindex="-1"])');
    console.log(`Found ${clickableTabs.length} clickable tabs`);

    for (let i = 0; i < Math.min(clickableTabs.length, 10); i++) {
      try {
        console.log(`Clicking tab ${i + 1}`);
        await clickableTabs[i].click();
        await page.waitForTimeout(1000);

        const tabName = await page.evaluate(() => {
          const active = document.querySelector('[role="tab"][aria-selected="true"]');
          return active ? active.textContent.trim().substring(0, 50) : `Tab_${i + 1}`;
        });

        console.log(`Taking screenshot ${tabCount + 1}: ${tabName}`);
        await page.screenshot({
          path: path.join(screenshotDir, `0${tabCount + 1}_${tabName.replace(/\s+/g, '_')}.png`),
          fullPage: true
        });

        tabCount++;
      } catch (err) {
        console.log(`Error clicking tab ${i}: ${err.message}`);
      }
    }

    // Get page source for hardcoded string analysis
    const pageSource = await page.content();
    fs.writeFileSync(path.join(screenshotDir, 'page_source.html'), pageSource);

    // Check for hardcoded English strings
    console.log('\nChecking for English strings...');
    const englishStrings = await page.evaluate(() => {
      const findings = [];
      const englishPatterns = [
        /Enable|Disable|Yes|No|Ok|Cancel|Save|Delete|Add|Remove|Edit|Update|Close|Open|Search|Filter|Sort|Export|Import/gi
      ];

      // Get all text nodes
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );

      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent.trim();
        if (text.length > 0 && text.length < 200) {
          for (const pattern of englishPatterns) {
            if (pattern.test(text) && !text.includes('Cyrillic')) {
              findings.push({
                text: text.substring(0, 100),
                parentTag: node.parentElement.tagName,
                className: node.parentElement.className
              });
            }
          }
        }
      }
      return findings.slice(0, 20);
    });

    console.log('Potential English strings found:', englishStrings.length);
    fs.writeFileSync(
      path.join(screenshotDir, 'english_findings.json'),
      JSON.stringify(englishStrings, null, 2)
    );

    console.log(`\nScreenshots saved to ${screenshotDir}`);
    const files = fs.readdirSync(screenshotDir);
    console.log('Files created:', files);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

captureScreenshots().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
