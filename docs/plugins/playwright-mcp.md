# Playwright MCP Plugin

Browser automation for Paperclip agents using Playwright MCP.

## Features

- **Full Browser Automation** — Navigate, click, fill, scroll, wait, extract
- **Visual Verification** — Full-page or element screenshots
- **JavaScript Execution** — Run arbitrary scripts in browser context
- **Smart Waiting** — Wait for elements, navigation, network idle
- **Data Extraction** — Extract structured data via CSS selectors

## Installation

```bash
pnpm add @paperclipai/plugin-playwright-mcp
```

Enable in your Paperclip config:

```yaml
# config.yaml
plugins:
  - playwright-mcp
```

Or via environment variable:

```bash
export PAPERCLIP_PLUGINS=playwright-mcp
```

## Available Tools

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

## Usage Examples

### Navigate and Verify

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

console.log(`Loaded: ${title} at ${url}`);
```

### Form Automation

```typescript
// Fill form and submit
await browser_fill({
  selector: "#email",
  value: "user@example.com",
  clear: true
});

await browser_fill({
  selector: "#password",
  value: "securepassword123",
  clear: true
});

await browser_click({
  selector: "button[type='submit']",
  waitForNavigation: true
});
```

### Data Extraction

```typescript
// Extract structured data
const product = await browser_extract({
  selectors: {
    name: ".product-title",
    price: ".price-current",
    description: ".product-description"
  }
});

console.log(product);
// { name: "Widget Pro", price: "$29.99", description: "..." }
```

### Visual Verification

```typescript
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

### JavaScript Execution

```typescript
// Execute custom JavaScript
const result = await browser_evaluate({
  script: `
    return {
      localStorageSize: Object.keys(localStorage).length,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    }
  `
});
```

## Browser Session Management

The plugin maintains a persistent browser session per agent. Sessions are automatically cleaned up when:

- Agent explicitly calls `browser_close`
- Agent session terminates
- Browser process times out (configurable, default: 300s)

### Session Reuse

```typescript
// Reuse session across multiple pages
await browser_navigate({ url: "https://example.com/page1" });
// ... do work ...

await browser_navigate({ url: "https://example.com/page2" });
// ... do more work ...

// Close when done
await browser_close({});
```

## Performance Tips

1. **Reuse sessions** — Navigate within the same session instead of creating new ones
2. **Use `networkidle`** — For SPAs, wait for network idle instead of just `load`
3. **Target screenshots** — Use `selector` for faster, smaller screenshots
4. **Batch extraction** — Use `browser_extract` with multiple selectors in one call
5. **Smart waits** — Use `browser_wait_for` instead of fixed delays

## Error Handling

```typescript
try {
  await browser_navigate({
    url: "https://example.com",
    waitUntil: "networkidle",
    timeout: 30000
  });
} catch (error) {
  console.error("Navigation failed:", error.message);
  // Fallback or retry logic
}
```

## Common Patterns

### Login Flow

```typescript
// Login
await browser_navigate({ url: "https://app.example.com/login" });
await browser_fill({ selector: "#email", value: EMAIL });
await browser_fill({ selector: "#password", value: PASSWORD });
await browser_click({ selector: "button[type='submit']", waitForNavigation: true });

// Verify login succeeded
await browser_wait_for({
  selector: "[data-testid='user-menu']",
  state: "visible"
});
```

### E2E Test Validation

```typescript
// Navigate to feature
await browser_navigate({ url: "https://app.example.com/dashboard" });

// Extract metrics
const metrics = await browser_extract({
  selectors: {
    revenue: ".metric-revenue .value",
    users: ".metric-users .value",
    growth: ".metric-growth .value"
  }
});

// Screenshot for report
await browser_screenshot({
  fullPage: true,
  path: `/tmp/dashboard-${Date.now()}.webp`
});
```

### Web Scraping

```typescript
// Scrape multiple items
const items = await browser_extract({
  selectors: {
    title: ".product-card h2",
    price: ".product-card .price",
    image: ".product-card img[src]",
    link: ".product-card a[href]"
  },
  multiple: true // extract all matching elements
});
```

## Requirements

- Playwright MCP server accessible (local or network)
- Node.js >= 20
- Paperclip server with plugin support enabled
- Playwright browsers installed: `npx playwright install`

## Troubleshooting

### Browser Not Launching

Ensure Playwright browsers are installed:

```bash
npx playwright install
```

### Navigation Timeout

Increase timeout or use a different wait condition:

```typescript
await browser_navigate({
  url: "https://slow-site.com",
  waitUntil: "domcontentloaded", // faster than "networkidle"
  timeout: 60000
});
```

### Element Not Found

Use `browser_wait_for` before interacting:

```typescript
await browser_wait_for({
  selector: "#dynamic-content",
  state: "visible",
  timeout: 10000
});

await browser_click({ selector: "#dynamic-content button" });
```

## License

MIT
