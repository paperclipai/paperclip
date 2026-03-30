# Playwright MCP Plugin

Browser automation for Paperclip agents using Playwright MCP.

## Features

- **Full Browser Automation** — Navigate, click, fill, scroll, wait, extract
- **Visual Verification** — Full-page or element screenshots
- **JavaScript Execution** — Run arbitrary scripts in browser context
- **Smart Waiting** — Wait for elements, navigation, network idle
- **Data Extraction** — Extract structured data via CSS selectors

## Tools

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL with configurable wait condition |
| `browser_click` | Click elements (left/right/middle, single/double-click) |
| `browser_fill` | Clear and fill form fields |
| `browser_screenshot` | Capture full-page or element screenshots (webp/png/jpeg) |
| `browser_extract` | Extract data using CSS selector mappings |
| `browser_evaluate` | Execute JavaScript in page context |
| `browser_wait_for` | Wait for element state (attached/detached/visible/hidden) |
| `browser_get_url` | Get current page URL |
| `browser_get_title` | Get current page title |
| `browser_close` | Close browser session |

## Usage

```typescript
// Navigate and verify
await browser_navigate({
  url: "https://especial.uniteia.com/br/unitv",
  waitUntil: "networkidle"
});

const { title, url } = await Promise.all([
  browser_get_title({}),
  browser_get_url({})
]);

// Fill form and submit
await browser_fill({
  selector: "#email",
  value: "user@example.com",
  clear: true
});

await browser_click({
  selector: "button[type='submit']",
  waitForNavigation: true
});

// Extract structured data
const product = await browser_extract({
  selectors: {
    name: ".product-title",
    price: ".price-current",
    description: ".product-description"
  }
});

// Take screenshot for visual verification
await browser_screenshot({
  fullPage: true,
  selector: ".main-content" // optional: screenshot specific element
});

// Wait for dynamic content
await browser_wait_for({
  selector: "[data-testid='load-complete']",
  state: "visible",
  timeout: 30000
});
```

## Browser Session Management

The plugin maintains a persistent browser session per agent. Sessions are automatically cleaned up when:
- Agent explicitly calls `browser_close`
- Agent session terminates
- Browser process times out (configurable, default: 300s)

## Performance Tips

1. **Reuse sessions** — Navigate within the same session instead of creating new ones
2. **Use `networkidle`** — For SPAs, wait for network idle instead of just `load`
3. **Target screenshots** — Use `selector` for faster, smaller screenshots
4. **Batch extraction** — Use `browser_extract` with multiple selectors in one call

## Requirements

- Playwright MCP server accessible (local or network)
- Node.js >= 20
- Paperclip server with plugin support enabled

## License

MIT
