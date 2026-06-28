---
name: agent-browser
description: Drive a real browser to inspect or interact with a web page or app — navigate, take screenshots, read console and network, fill simple forms — for verification tasks, not unattended automation.
key: paperclipai/optional/browser/agent-browser
recommendedForRoles:
  - qa
  - engineer
  - researcher
tags:
  - browser
  - puppeteer
  - playwright
  - verification
---

# Agent Browser

Use a controlled browser to verify behavior, capture evidence, or extract information from web pages that a static fetch cannot reach (SPAs, login-gated pages, dynamic content). This skill is about supervised verification, not unattended scraping.

## When to use

- You need a screenshot of a deployed page or a local dev server to confirm a UI change.
- You need to read JavaScript-rendered content that `curl`/`wget` will not see.
- A user reports a UI bug and you need to reproduce it interactively to capture console errors, network requests, or layout state.
- You need to walk through a short flow (load page, click, observe) to verify acceptance criteria.

## When not to use

- The page is reachable as static HTML. Use `curl`/HTTP fetch — it is cheaper, faster, and more reliable.
- The task is unattended large-scale scraping. That belongs to a dedicated scraper with rate limits, robots.txt handling, and a real user agent policy — not this skill.
- The site is behind authentication you do not own credentials for, or whose terms of service prohibit automation.
- The site involves sensitive accounts (banking, healthcare, government) where automation risks lockout or compliance issues.

## Before launching the browser

- Confirm the URL and what state should be true after navigation.
- Decide what evidence is needed: full-page screenshot, viewport screenshot, console log, network trace, HTML snapshot, extracted text.
- Decide the viewport size that matters for the task (mobile vs desktop). Default to a desktop size unless the task is mobile-specific.
- For local dev servers, confirm the server is running and the port is what you expect.

## Driving the browser

A typical verification session:

1. **Launch with a real-looking user agent** when the target is the public internet; an unrealistic UA flags automation traffic.
2. **Set a sane viewport** (e.g., 1366×768 desktop, 390×844 iPhone-ish).
3. **Navigate and wait for the right signal.** Prefer waiting for a specific selector or network-idle over arbitrary sleeps.
4. **Capture evidence immediately** after the wait condition succeeds, before any interaction perturbs the state.
5. **Interact deliberately.** One click at a time, with a wait between actions; re-screenshot after each meaningful state change.
6. **Read the console and network panels** for unexpected errors, 4xx/5xx responses, or slow requests.
7. **Close the browser cleanly** when done. Long-running browser sessions leak memory and hold ports.

## What evidence to record

For a verification task, deliver:

- A full-page or viewport screenshot of each meaningful state.
- The console log, filtered to warnings/errors.
- Any non-2xx network response with the URL, status, and a short response body excerpt.
- A short narration: "Navigated to X, observed Y, clicked Z, observed W."

For a UI bug repro, also record:

- The exact reproduction steps the user can follow.
- Viewport size and (where relevant) device pixel ratio.
- Whether the bug reproduces on first load vs after interaction.

## Login-gated pages

- Prefer programmatic auth (API token, magic link) over UI login.
- If UI login is the only path, the user must provide credentials explicitly for this run. Never reuse credentials outside the session.
- Do not store credentials in the session log, screenshot, or returned output.

## Performance and politeness

- Throttle to one navigation per few seconds when touching shared infra.
- Respect `robots.txt` for public sites you are inspecting at any volume.
- Cancel navigations if a page exceeds a reasonable timeout (e.g., 30s); the page is broken or rate-limiting you.
- Do not retry forever on failure. Retry once with a longer timeout, then escalate.

## Common failure modes

- **Selector not found.** Page changed, or you are waiting before render. Take a screenshot to see actual state; adjust the selector.
- **Click does nothing.** The element is offscreen, covered by a modal, or in a shadow DOM. Scroll into view or pierce the shadow root.
- **Headless detection.** Some sites detect headless Chrome and serve a different page. Use a non-headless mode or a fingerprint-realistic configuration only when authorized.
- **Cross-origin iframe blocking.** Iframes you do not own cannot be inspected; the page must offer the data outside the iframe or the task is infeasible.

## Anti-patterns

- Long unsupervised browser sessions that drift from the original task.
- Scraping behind authentication you do not own.
- Captioning a screenshot with "looks good" without saying what state was loaded and what selectors confirmed it.
- Treating a passing screenshot as proof of correctness across viewports you did not actually test.
