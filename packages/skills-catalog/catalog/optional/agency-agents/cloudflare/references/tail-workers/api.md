# Tail Workers APIs

Fetch the handler reference for current event shapes and language examples instead of maintaining local interface definitions.

| Task | Documentation |
| --- | --- |
| Implement the handler and understand asynchronous processing | [Tail handler syntax](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/#syntax) |
| Interpret execution outcomes, logs, exceptions, and timestamps | [Tail handler event reference](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) |
| Inspect request fields and redaction behavior | [TailRequest](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/#tailrequest) |
| Interpret events from dynamic dispatch and user Workers | [Handler parameters](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/#parameters) |
| Write aggregated metrics | [Analytics Engine from Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/#use-analytics-engine-for-aggregated-metrics) |

Choose the event fields required by the destination and preserve the distinction between execution outcome and HTTP response status. Review what data may be retained before bypassing redaction; the documented heuristics are not a complete application privacy policy. See [patterns.md](./patterns.md) for filter design.
