# Browser Run Troubleshooting

Identify the integration and observed failure before changing timeouts or concurrency. A request-rate limit, exhausted browser time, and a closed session require different responses.

| Concern | Documentation |
|---------|---------------|
| Quotas, launch rates, concurrency, and session timeouts | [Limits](https://developers.cloudflare.com/browser-run/limits/) — check the current plan and integration-specific limits |
| Browser hours and concurrent-browser charges | [Pricing](https://developers.cloudflare.com/browser-run/pricing/) — distinguish Quick Actions from browser sessions |
| Missing bindings, action failures, or unsupported behavior | [FAQ](https://developers.cloudflare.com/browser-run/faq/) — diagnose the reported error and runtime constraints |
| Puppeteer page evaluation cannot access outer variables | [JavaScript execution](https://pptr.dev/guides/javascript-execution) — browser execution context, passing arguments, and returned values |
| Block resources or handle intercepted Puppeteer requests | [Request interception](https://pptr.dev/guides/network-interception) — continue, respond, or abort requests and avoid duplicate handling |
| Unexpected disconnects or session loss | [Browser close reasons](https://developers.cloudflare.com/browser-run/reference/browser-close-reasons/) — inspect the recorded close reason before choosing recovery |
| Development or compatibility failures | [Wrangler reference](https://developers.cloudflare.com/browser-run/reference/wrangler/) — verify binding configuration and interface-specific development support |

Before increasing concurrency, check session cleanup and whether the workload can reuse browsers with appropriate isolation; see [patterns.md](patterns.md). Retrieve current limits and pricing when sizing a workload rather than relying on fixed tier tables.
