---
name: qa-playwright-walkthrough
description: >
  How QA Verifier runs browser walkthroughs and Lighthouse audits in the
  Debian 13 ARM64 Docker container. Replaces browser-use (Mac-only) with
  Playwright using the system Chromium binary.
---

# QA Playwright Walkthrough

Use this skill instead of `browser-use` when running in the Docker container (linuxkit/Linux environment).

## Environment

- Chromium: `/usr/bin/chromium` (installed via apt)
- Playwright: global npm package, configured to use system chromium
- Lighthouse: global npm package

## Browser Walkthrough via Playwright

Write an inline script `/tmp/qa-walk.cjs` for each QA task, then run it:

```javascript
const { chromium } = require('playwright'); // NODE_PATH makes this resolvable

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  // --- Verification checks ---
  await page.goto('http://localhost:3010/blog/my-slug');
  // Check 1: page title
  const title = await page.title();
  if (!title.includes('Expected Title')) throw new Error(`Title mismatch: ${title}`);

  // Check 2: element visible
  await page.waitForSelector('.blog-hero-image', { timeout: 5000 });

  // Add checks from the plan's Verification section here

  await browser.close();
  console.log('All checks passed');
})();
```

Run it:
```bash
node /tmp/qa-walk.cjs
```

Any thrown error = BLOCK. Script exits 0 = checks passed.

## Lighthouse Audit

```bash
lighthouse http://localhost:3010/blog/my-slug \
  --chrome-path /usr/bin/chromium \
  --chrome-flags="--headless --no-sandbox --disable-dev-shm-usage" \
  --preset=desktop \
  --output=json \
  --output-path=/tmp/lh-desktop.json

lighthouse http://localhost:3010/blog/my-slug \
  --chrome-path /usr/bin/chromium \
  --chrome-flags="--headless --no-sandbox --disable-dev-shm-usage" \
  --output=json \
  --output-path=/tmp/lh-mobile.json

# Extract metrics
jq '{
  perf: .categories.performance.score,
  inp: .audits["interaction-to-next-paint"].numericValue,
  lcp: .audits["largest-contentful-paint"].numericValue,
  cls: .audits["cumulative-layout-shift"].numericValue
}' /tmp/lh-desktop.json
```

Targets: INP < 200ms, LCP < 2.5s, CLS < 0.1. Regression >5% on any → BLOCK.

## Verification (after image rebuild)

```bash
chromium --version        # should print version string
lighthouse --version      # should print version string
node -e "require('playwright'); console.log('playwright ok')"
```
