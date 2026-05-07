---
name: gstack-setup-browser-cookies
description: >
  Import cookies from your real browser into the headless browser session.
  Opens an interactive picker where you select which cookie domains to import.
  Use before QA testing authenticated pages. Use when asked to "import cookies",
  "login to site", or "authenticate browser".
---

# Setup Browser Cookies

Import logged-in sessions from your real browser into the headless browser session for QA testing authenticated pages.

## How it works

1. Detect installed browsers (Chrome, Edge, Brave, Arc)
2. Let you select which cookie domains to import
3. Load those cookies into the browser session

## Steps

### 1. Identify the target domain

Ask the user which site they need to be logged into:
- "Which site do you need to authenticate for?"
- Common examples: github.com, localhost:3000, your-app.com

### 2. Check current browser state

First, navigate to the site and check if already authenticated:
```
mcp__chrome-devtools__navigate_page with url: target site
mcp__chrome-devtools__take_snapshot
```

Look for authentication indicators:
- User avatar/menu
- "Sign in" button (means NOT logged in)
- Dashboard content (means logged in)

### 3. If not authenticated

The Chrome DevTools browser shares cookies with your Chrome profile by default. If you need cookies from a different browser:

**Option A: Use Chrome profile**
- The MCP Chrome tools use your Chrome profile
- Log into the site in your regular Chrome browser
- The session should carry over

**Option B: Manual authentication**
- Navigate to the login page
- Use AskUserQuestion to have the user log in manually
- Continue testing after authentication

### 4. Verify authentication

After setup:
```
mcp__chrome-devtools__navigate_page with url: target site
mcp__chrome-devtools__take_snapshot
```

Confirm you see authenticated state (user menu, dashboard, etc.)

## Notes

- Chrome DevTools Protocol uses your Chrome profile by default
- For isolated sessions, use the `isolatedContext` parameter in `mcp__chrome-devtools__new_page`
- Cookies persist within the browser session
- For complex auth (OAuth, MFA), may need manual user intervention

## When Auth Fails

If you can't authenticate automatically:
1. Tell the user: "I need your help to authenticate"
2. Open the login page in the browser
3. Use AskUserQuestion: "Please log in at {url}, then tell me when you're done"
4. After they confirm, continue testing
