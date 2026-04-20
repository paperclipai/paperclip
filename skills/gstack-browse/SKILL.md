---
name: gstack-browse
description: >
  Fast headless browser for QA testing and site dogfooding. Navigate any URL, interact with
  elements, verify page state, diff before/after actions, take annotated screenshots, check
  responsive layouts, test forms and uploads, handle dialogs, and assert element states.
  Use when you need to test a feature, verify a deployment, dogfood a user flow, or file a bug
  with evidence. Use when asked to "open in browser", "test the site", "take a screenshot",
  or "dogfood this".
---

# Browse: QA Testing & Dogfooding

Use Chrome DevTools Protocol tools to interact with web pages for testing and verification.

## Core QA Patterns

### 1. Verify a page loads correctly
```
Navigate to URL: mcp__chrome-devtools__navigate_page
Get page content: mcp__chrome-devtools__take_snapshot
Check console: mcp__chrome-devtools__list_console_messages
Check network: mcp__chrome-devtools__list_network_requests
Verify element: mcp__chrome-devtools__take_snapshot (look for element in tree)
```

### 2. Test a user flow
```
Navigate: mcp__chrome-devtools__navigate_page
Get interactive elements: mcp__chrome-devtools__take_snapshot (shows @refs)
Fill form: mcp__chrome-devtools__fill or mcp__chrome-devtools__fill_form
Click button: mcp__chrome-devtools__click
Verify result: mcp__chrome-devtools__take_snapshot (check for success state)
```

### 3. Verify an action worked
```
Baseline: mcp__chrome-devtools__take_snapshot
Perform action: mcp__chrome-devtools__click or mcp__chrome-devtools__fill
After: mcp__chrome-devtools__take_snapshot
Compare snapshots to see what changed
```

### 4. Visual evidence for bug reports
```
Navigate: mcp__chrome-devtools__navigate_page
Annotated snapshot: mcp__chrome-devtools__take_snapshot
Screenshot: mcp__chrome-devtools__take_screenshot
Console errors: mcp__chrome-devtools__list_console_messages
```

### 5. Test responsive layouts
```
Set viewport: mcp__chrome-devtools__emulate with viewport parameter
Screenshot: mcp__chrome-devtools__take_screenshot
Repeat for different sizes
```

### 6. Assert element states
```
Check visibility: Look at snapshot output for element presence
Check enabled/disabled: Look at element attributes in snapshot
Check focus: mcp__chrome-devtools__evaluate_script with document.activeElement
```

### 7. Test file uploads
```
mcp__chrome-devtools__upload_file with file input selector and local file path
```

### 8. Handle dialogs
```
Set up handler: mcp__chrome-devtools__handle_dialog with action="accept" or "dismiss"
Trigger dialog: mcp__chrome-devtools__click or navigate
```

## Key Commands

| Command | Tool | Description |
|---------|------|-------------|
| Navigate | `mcp__chrome-devtools__navigate_page` | Go to URL |
| Snapshot | `mcp__chrome-devtools__take_snapshot` | Get page as accessibility tree with @refs |
| Click | `mcp__chrome-devtools__click` | Click element by @ref |
| Fill | `mcp__chrome-devtools__fill` | Type into input by @ref |
| Fill Form | `mcp__chrome-devtools__fill_form` | Fill multiple fields at once |
| Screenshot | `mcp__chrome-devtools__take_screenshot` | Capture page or element |
| Console | `mcp__chrome-devtools__list_console_messages` | Get JS console messages |
| Network | `mcp__chrome-devtools__list_network_requests` | Get network requests |
| Wait | `mcp__chrome-devtools__wait_for` | Wait for text to appear |
| Evaluate JS | `mcp__chrome-devtools__evaluate_script` | Run JavaScript |
| Upload | `mcp__chrome-devtools__upload_file` | Upload file to input |

## Snapshot Output Format

The snapshot shows the accessibility tree with unique identifiers (@refs):
```
- [heading] "Welcome" [level=1]
- [textbox] "Email" @e2
- [button] "Submit" @e3
```

Use @refs in subsequent commands:
- `mcp__chrome-devtools__click` with `uid: "@e3"`
- `mcp__chrome-devtools__fill` with `uid: "@e2"` and `value: "test@example.com"`

## Important Rules

1. **Always snapshot before interacting** — you need @refs to identify elements
2. **Check console after every interaction** — JS errors that don't surface visually are still bugs
3. **Use wait_for for dynamic content** — wait for text to appear before proceeding
4. **Show screenshots to users** — use Read tool on screenshot files so users can see them
5. **Never refuse to use the browser** — when user asks for browser testing, always use these tools

## User Handoff

When you hit something you can't handle (CAPTCHA, complex auth, MFA):
1. Tell the user what you're stuck on
2. Use AskUserQuestion to get their help
3. After they complete the step, continue testing
