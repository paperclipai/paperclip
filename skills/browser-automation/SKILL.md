---
name: browser-automation
description: >
  Interact with third-party websites using a real browser (Playwright).
  Use when a task requires logging in, navigating, reading data, filling forms,
  or triggering actions on any web app that has no API — e.g. Greythr, job
  portals, vendor portals, government sites. Do NOT use when a REST API exists.
---

# Browser Automation Skill

You control a real **Chromium browser** via Playwright MCP tools.
You can navigate any website, log in, read content, fill forms, click buttons,
and extract data — just like a human would.

---

## Available Tools (Playwright MCP)

| Tool | Purpose |
|------|---------|
| `browser_navigate` | Go to a URL |
| `browser_snapshot` | Read page content as accessibility tree (fast, no screenshot) |
| `browser_take_screenshot` | Visual screenshot for verification |
| `browser_click` | Click any element |
| `browser_type` | Type text into a field |
| `browser_fill_form` | Fill multiple form fields at once |
| `browser_select_option` | Select from a dropdown |
| `browser_press_key` | Press keyboard keys (Enter, Tab, Escape) |
| `browser_hover` | Hover over an element |
| `browser_wait_for` | Wait for element or text to appear |
| `browser_evaluate` | Run JavaScript on the page |
| `browser_network_requests` | Inspect network calls |
| `browser_console_messages` | Read browser console logs |
| `browser_tabs` | Manage browser tabs |
| `browser_navigate_back` | Go back |

---

## Standard Login Flow

```
1. browser_navigate url="https://target-site.com/login"
2. browser_snapshot → identify login form fields
3. browser_type element="email input" text="{email}"
4. browser_type element="password input" text="{password}"
5. browser_click element="Login / Sign In button"
6. browser_wait_for text="Dashboard" OR browser_snapshot to confirm login
```

## Read Data from a Page

```
1. browser_navigate url="..."
2. browser_snapshot → returns full page accessibility tree
3. Extract the data you need from snapshot
4. If pagination: browser_click "Next page" → repeat
```

## Fill and Submit a Form

```
1. browser_navigate url="..."
2. browser_snapshot → identify form fields
3. browser_fill_form fields={...}
4. browser_click element="Submit button"
5. browser_snapshot → verify success message
```

---

## Greythr Workflow

Greythr is Medicodio's HR management system.

### Leave Management
```
1. browser_navigate url="https://medicodio.greythr.com"
2. Login with HR credentials (from env: GREYTHR_EMAIL, GREYTHR_PASSWORD)
3. Navigate to Leave → Approvals
4. browser_snapshot → list pending requests
5. browser_click Approve/Reject per task instructions
6. browser_snapshot → confirm action taken
```

### Attendance
```
1. Login → Attendance → Reports
2. browser_snapshot → read attendance data
3. Extract and summarise in Paperclip issue comment
```

### Onboarding
```
1. Login → Employees → Add New Employee
2. browser_fill_form with new hire details
3. Submit → confirm
4. Screenshot for audit trail
```

---

## Critical Rules

- **Always `browser_snapshot` first** before clicking — confirms you are on the right page.
- **Always screenshot after form submit** — proof of action for audit trail.
- **Never store credentials in comments** — use env vars only.
- **Use `browser_wait_for`** after navigation before reading — pages may load async.
- **On unexpected page** (error, captcha, 2FA): stop, update issue to `blocked`, screenshot the page, ask for human help.
- **Headless mode** — browser runs invisibly in background, no window shown.

---

## Env vars for HR

```
GREYTHR_EMAIL      — HR login email
GREYTHR_PASSWORD   — HR login password  
GREYTHR_URL        — e.g. https://medicodio.greythr.com
```

These are injected by Paperclip from company secrets at runtime.
