# Playwright QA — Code Snippets

> This file is referenced by SKILL.md. Read it when writing QA scripts or generating reports.

## Basic Page Test

```typescript
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

// Collect errors
const errors: string[] = []
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('requestfailed', req => {
  errors.push(`NETWORK: ${req.url()} — ${req.failure()?.errorText}`)
})

await page.goto('http://localhost:3000')
await page.waitForLoadState('networkidle')

// Check for errors
if (errors.length > 0) {
  console.log('BUGS FOUND:', errors)
}

await browser.close()
```

## Mobile Viewport Test

```typescript
const context = await browser.newContext({
  viewport: { width: 375, height: 812 },
  userAgent: 'Mozilla/5.0 (iPhone 14)',
})
const page = await context.newPage()
await page.goto('http://localhost:3000')

// Check for horizontal scroll (layout bug)
const hasHScroll = await page.evaluate(() =>
  document.documentElement.scrollWidth > document.documentElement.clientWidth
)
if (hasHScroll) {
  console.log('BUG: Horizontal scroll on mobile')
}
```

## Form Test

```typescript
// Test empty submit (should show validation)
await page.click('button[type="submit"]')
const validationVisible = await page.locator('.error, [role="alert"]').count()

// Test valid submit
await page.fill('input[name="email"]', 'test@example.com')
await page.fill('input[name="password"]', 'password123')
await page.click('button[type="submit"]')
await page.waitForURL('**/dashboard')
```

## Screenshot on Failure

```typescript
try {
  await page.goto(url)
  // ... checks ...
} catch (e) {
  await page.screenshot({ path: `qa-failure-${Date.now()}.png`, fullPage: true })
  throw e
}
```

## QA Report Template

```markdown
## QA Report
Date: YYYY-MM-DD
Target: http://localhost:3000

### Summary
| Metric | Count |
|--------|-------|
| Pages tested | N |
| Bugs found | N |
| Warnings | N |
| Passed | N |

### Bugs
BUG-1: [title]
- Page: [URL]
- Steps: [reproduce]
- Expected: [what should happen]
- Actual: [what happened]
- Severity: blocker / major / minor
- Auto-fixable: yes / no

### Warnings
WARN-1: [title]
- Page: [URL]
- Issue: [description]

### Passed
- /page-a — all checks clear
- /page-b — all checks clear
```
