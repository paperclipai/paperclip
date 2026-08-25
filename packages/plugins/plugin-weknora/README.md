# @paperclipai/plugin-weknora

Thin Paperclip connector for a WeKnora deployment. WeKnora remains the authority for knowledge bases, documents, chunks, wiki pages, and lint findings; this package does not mirror or persist those resources.

## Install and configure

Install the package through the Paperclip plugin manager. Configure a company instance with:

- `baseUrl`: an HTTP(S) origin or API root. The plugin normalizes it to `/api/v1` and rejects URL credentials and fragments.
- `apiKeyRef`: a Paperclip `secret_ref` object. The resolved value is used only for the current outbound request.
- Optional `tenantId` and default knowledge-base ids.
- `resourceUrls: "handle"` (fixed in V1), result/character limits, and request timeout.
- `enableWriteActions: false` unless the board explicitly wants manual or URL ingest and wiki maintenance actions.

The plugin sends `X-API-Key`, optional `X-Tenant-ID`, and a generated `X-Request-ID`. It refuses redirects, caps result/page sizes, clips oversized content, and retries only idempotent reads (at most two retries). Knowledge-base listings are bounded by `maxResults` and report known `total`/`truncated` state. Manual and URL ingest requests have a 1 MB serialized JSON body limit. Ingest, rebuild-links, and auto-fix writes are never retried.

Health output uses allowlisted counters, identifiers, and timestamps. Unknown upstream fields, headers, markup, secret-like values, and free-form issue messages are not passed to agent tools or the UI. Authentication and configuration failures make the complete health result unavailable; unrelated wiki endpoint failures produce a degraded partial result.

## Operator smoke prerequisites

Before a live smoke test, Operations must provide the endpoint/network facts, confirm the WeKnora version and Swagger contract, create a Paperclip secret with the required `retrieve` scope, and choose a wiki-enabled knowledge base. Add `ingest` scope only when board writes are enabled. Live verification is outside the repository-local test contract.

## Surfaces

Seven read-only agent tools are registered: knowledge-base list, search, document read, wiki list/read/search, and health. The UI provides overview, knowledge-base/wiki browsing, query with document context, and health views. Board-only actions and routes cover manual/URL ingest, wiki link rebuild, and wiki auto-fix; they are disabled by default. The plugin does not expose a second MCP server, agent write tools, multipart file ingest, or a plugin database.
