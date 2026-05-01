---
schema: agentcompanies/v1
kind: skill
slug: browser-qa
name: Browser QA — Playwright + Lighthouse setup
description: How to run visual browser walkthroughs and Lighthouse audits from the QA sandbox. Covers Playwright install, headless Chromium, and Mac-local fallback.
---

# Browser QA — Playwright + Lighthouse Setup

## Environment reality check

Run this first to know which path applies:

```bash
which chromium chromium-browser google-chrome 2>/dev/null && echo "SYSTEM CHROME OK" || echo "NO SYSTEM CHROME"
npx playwright --version 2>/dev/null && echo "PLAYWRIGHT OK" || echo "NO PLAYWRIGHT"
sudo apt-get -qq install --dry-run libnss3 2>&1 | grep -q "^libnss3" && echo "APT OK" || echo "NO SUDO/APT"
```

## Path 1 — Playwright Chromium (preferred, works when Docker image has system libs)

### Step 1: Install bundled Chromium

```bash
PLAYWRIGHT_BROWSERS_PATH=/paperclip/.cache/ms-playwright \
  npx playwright install chromium 2>&1
```

This downloads Chromium to `/paperclip/.cache/ms-playwright/`. It persists between runs in the same instance.

### Step 2: Verify it launches

```bash
npx playwright --version
node -e "
const { chromium } = require('playwright');
chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] })
  .then(b => { console.log('CHROME OK'); b.close(); })
  .catch(e => { console.error('CHROME FAIL:', e.message.split('\n')[0]); process.exit(1); });
"
```

If this fails with missing shared libraries (`libnss3`, `libglib-2.0-0`, etc.), the Docker image needs those packages installed. **Escalate to Chief Engineering via KOEA-251** — do not skip browser walkthrough.

### Step 3: Run visual QA script

```javascript
// qa-walkthrough.mjs — adapt per ticket
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
});

const checks = [
  { url: 'http://localhost:3010/', label: 'Home', viewport: { width: 375, height: 812 } },
  { url: 'http://localhost:3010/catalog', label: 'Catalog', viewport: { width: 375, height: 812 } },
  { url: 'http://localhost:3010/blog', label: 'Blog', viewport: { width: 375, height: 812 } },
  { url: 'http://localhost:3010/', label: 'Home desktop', viewport: { width: 1280, height: 800 } },
];

for (const check of checks) {
  const page = await browser.newPage();
  await page.setViewportSize(check.viewport);
  await page.goto(check.url, { waitUntil: 'networkidle', timeout: 30000 });
  // Capture screenshot
  await page.screenshot({ path: `/tmp/qa-${check.label.replace(/ /g,'-')}.png` });
  // Check for horizontal scroll
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  console.log(`${check.label}: scrollWidth=${scrollWidth} clientWidth=${clientWidth} overflow=${scrollWidth > clientWidth ? 'YES ❌' : 'NO ✅'}`);
  await page.close();
}

await browser.close();
```

Run: `node qa-walkthrough.mjs`

## Path 2 — Lighthouse (requires Chromium working from Path 1)

```bash
# Install lighthouse globally if not present
npm list -g lighthouse 2>/dev/null || npm install -g lighthouse

# Run mobile audit
lighthouse http://localhost:3010/blog/SLUG \
  --preset=mobile \
  --output=json \
  --output-path=/tmp/lighthouse-mobile.json \
  --chrome-flags="--headless --no-sandbox --disable-setuid-sandbox" \
  2>/dev/null

# Extract scores
node -e "
const r = JSON.parse(require('fs').readFileSync('/tmp/lighthouse-mobile.json'));
const cats = r.categories;
console.log('Performance:', Math.round(cats.performance.score * 100));
console.log('CLS:', r.audits['cumulative-layout-shift'].numericValue.toFixed(3));
console.log('LCP:', r.audits['largest-contentful-paint'].numericValue.toFixed(0) + 'ms');
"
```

Pass threshold: Performance ≥ 85, CLS < 0.05, LCP < 2500ms.

## Path 3 — Static DOM fallback (when Chromium unavailable)

Use when Chrome cannot launch. Verifies HTML structure, routing, accessibility attributes — but cannot confirm rendered CSS, animations, or Lighthouse scores.

```bash
# Start dev server
cd /Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/learnova-academy
pnpm dev --port 3010 &
sleep 8

# Fetch and check pages
for path in / /catalog /blog /tutor /blog/2026-04-30-anthropic-creative-connectors; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3010$path")
  has_nav=$(curl -s "http://localhost:3010$path" | grep -c 'class="bottom-nav"')
  echo "GET $path → $status | bottom-nav: $has_nav"
done
```

**Escalate to Chief Engineering any time you use Path 3 for a visual/CSS change** — static DOM analysis is not a substitute for rendered visual check. Document which checks were static vs visual in your PASS/BLOCK comment.

## Path 4 — Mac-local (future state, when browser-use adapter is wired)

When the `browser-use` adapter is registered in Paperclip and assigned to this agent:

```bash
# The adapter runs natively on the Mac with Chrome available
browser-use --script qa-walkthrough.py --url http://localhost:3010
```

See `adapters/browser-use/` for adapter implementation status. This is the intended long-term path (KOEA-251).

## Escalation: Docker image missing system libs

If `npx playwright install chromium` succeeds but Chrome fails to launch with missing library errors, collect the list and escalate:

```bash
npx playwright install chromium 2>&1
# Then test:
PLAYWRIGHT_BROWSERS_PATH=/paperclip/.cache/ms-playwright \
  /paperclip/.cache/ms-playwright/chromium-*/chrome-linux/chrome --headless --dump-dom about:blank 2>&1 | head -30
```

Required apt packages for the Docker base image (requires Vardaan / root):

```bash
apt-get install -y --no-install-recommends \
  libnss3 libglib2.0-0t64 libatk1.0-0t64 libdbus-1-3 \
  libatspi2.0-0t64 libx11-6 libxcomposite1 libxdamage1 \
  libxext6 libxfixes3 libxrandr2 libgbm1 libxcb1 \
  libxkbcommon0 libasound2t64 libnspr4 libcairo2 libpango-1.0-0
```

File a comment on [KOEA-251](/KOEA/issues/KOEA-251) with this list and block the QA issue. Do not declare PASS on visual checks via static analysis alone.
