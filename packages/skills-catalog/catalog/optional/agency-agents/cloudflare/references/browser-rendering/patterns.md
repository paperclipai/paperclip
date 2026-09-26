# Browser Run Patterns

Use the current examples for the selected integration instead of translating between Puppeteer, Playwright, and Quick Actions by changing method names.

| Task | Documentation |
|------|---------------|
| Implement screenshots, PDFs, or extraction | [Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/) — choose the action and follow its example |
| Build custom interactions | [Puppeteer](https://developers.cloudflare.com/browser-run/puppeteer/) or [Playwright](https://developers.cloudflare.com/browser-run/playwright/) — browser automation examples |
| Reconnect across requests | [Reuse sessions](https://developers.cloudflare.com/browser-run/features/reuse-sessions/) — disconnect/reconnect lifecycle and when to use Durable Objects for stateful ownership |
| Share browser capacity while isolating users | [Concurrency and session isolation](https://developers.cloudflare.com/browser-run/limits/#how-can-i-manage-concurrency-and-session-isolation-with-browser-run) — tabs, browser contexts, and capacity tradeoffs |

Quick Actions manage their own session lifecycle. For sessions managed by the application, close pages and browsers on completion or failure. If reuse is intentional, follow the client's disconnect/reconnect semantics and handle expired sessions; closing the browser ends it. Keep cookies and storage isolated between users, and coordinate ownership when several requests can reconnect to the same session.
