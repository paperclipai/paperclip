---
name: "browser-qa"
description: "Run real browser QA with Playwright. Use when testing a frontend feature, verifying UI before PR, smoke testing after deploy, or investigating reported visual bugs."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
key: "paperclipai/optional/agency-agents/browser-qa"
recommendedForRoles:
  - "engineer"
  - "designer"
  - "researcher"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "researcher"
  - "browser"
defaultInstall: false
---
# Browser QA Skill

Test web apps with a real browser. Find bugs users would find.

## When to Use

- After building a frontend feature
- Before creating a PR for UI changes
- When user reports "something looks broken"
- Smoke testing after deploy

## What This Skill Does

1. Launches Playwright with real Chromium
2. Hits every discoverable page in the app
3. Checks for console errors, network failures, broken assets
4. Tests interactive elements (forms, buttons, links)
5. Verifies mobile responsiveness
6. Produces a structured QA report

## QA Check Categories

### 1. Page Health
Every page gets these checks:
- HTTP status is 2xx
- No JavaScript console errors
- No failed network requests (4xx/5xx)
- No missing images or assets
- Page loads in under 3 seconds

### 2. Layout & Responsive
- Desktop (1280px): no horizontal scroll, no overlapping elements
- Mobile (375px): no horizontal scroll, text is readable, buttons are tappable
- No content clipped or hidden unintentionally

### 3. Interactive Elements
- Buttons: click → something happens (no dead buttons)
- Links: click → navigates to valid page (no 404s)
- Forms: submit empty → validation shows. Submit valid → success feedback.
- Dropdowns/modals: open → content visible. Close → content hidden.

### 4. Navigation Flow
- Every link in nav goes somewhere valid
- Back button works as expected
- Breadcrumbs (if present) are accurate
- Auth redirects work (protected page → login → redirect back)

### 5. Data Display
- Lists show data (not empty state when data exists)
- Pagination works (if present)
- Search/filter updates results
- Loading states show during data fetch
- Error states show when API fails

## Playwright Patterns & Report Template

> See playwright-snippets.md for ready-to-use Playwright code (page tests, mobile viewport, form testing, screenshot on failure) and the QA report template.

## Gotchas

- **`networkidle` waits forever on apps with websockets or polling.** Use `domcontentloaded` or a specific element selector instead if the app has live connections.
- **`page.click()` on invisible elements passes silently.** Always verify the element is visible before interacting. Use `await expect(locator).toBeVisible()` first.
- **Mobile viewport test without touch simulation misses real bugs.** Set `hasTouch: true` in the browser context, not just the viewport size.
- **Console warnings are not console errors.** Don't report React hydration warnings or deprecation notices as bugs. Only `console.error` and failed network requests are bugs.
- **Screenshots on CI look different than local.** Font rendering, antialiasing, and DPI differ between macOS and Linux. Use visual comparison thresholds, not pixel-perfect matching.

## Rules

- **Real browser only.** Playwright + Chromium. No HTTP-only testing.
- **Headless by default.** Don't open visible windows unless asked.
- **Test both viewports.** Desktop (1280px) and mobile (375px).
- **Console errors = bugs.** Always report them.
- **One-shot mode.** Launch browser, test, close. No daemon.
- **Screenshot failures.** Take a screenshot when something breaks.
- **Don't fix without asking.** Report first, then offer fixes.
