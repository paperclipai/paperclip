# Browse the Web (Experimental)

Fetch https://developers.cloudflare.com/agents/api-reference/browse-the-web/ for complete documentation.

CDP-powered browser tools that let agents scrape, screenshot, and interact with web pages.

## Setup

```jsonc
// wrangler.jsonc
{
  "browser": { "binding": "BROWSER" },
  "worker_loaders": [{ "binding": "LOADER" }],
  "compatibility_flags": ["nodejs_compat"]
}
```

## Usage with AI SDK

```typescript
import { createBrowserTools } from "agents/browser/ai";

export class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    const browserTools = createBrowserTools({
      browser: this.env.BROWSER,
      loader: this.env.LOADER
    });

    const result = streamText({
      model: openai("gpt-4o"),
      messages: await convertToModelMessages(this.messages),
      tools: { ...myTools, ...browserTools },
      onFinish
    });
    return result.toUIMessageStreamResponse();
  }
}
```

## Available Tools

| Tool | Purpose |
|------|---------|
| `browser_search` | Search the web and return results |
| `browser_execute` | Navigate to URL, execute JS, return results |

The LLM writes async JavaScript IIFEs that run in a fresh browser session.

## When to Use

- Need a real browser (JS rendering, screenshots, interaction) → browser tools
- Just need HTML/API data → use `fetch()` instead (faster, cheaper)

## Low-Level API

```typescript
import { connectBrowser, CdpSession } from "agents/browser";

const browser = await connectBrowser(this.env.BROWSER);
const cdp = new CdpSession(browser);
await cdp.send("Page.navigate", { url: "https://example.com" });
```
