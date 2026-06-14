# Remote MCP URL connect — UX decision

**Issue:** [PAP-11088](/PAP/issues/PAP-11088) (Phase 5 of [PAP-11041](/PAP/issues/PAP-11041#document-plan))
**Decision:** the existing gallery "Connect with a link" affordance is sufficient for the KV demo and any other `remote_http` MCP server. No new UI screen is required. Two thin copy/docs fixes plus one out-of-scope follow-up bug are filed alongside.

## What I reviewed

Surfaces inspected on `PAP-10341` branch (file:line refs are evidence, not links):

1. `ui/src/pages/apps/AppsConnect.tsx:471–521` — gallery's "Connect with a link" affordance: URL input + Continue button. Accepts any `http(s)://` URL (`normalizeAppLink`, line 576). No JSON wrapper required.
2. `ui/src/pages/apps/AppsConnect.tsx:594–707` — `LinkConnectStep`: name field, "Does it need a key?" toggle, optional password field. Submits via `connectApp({ link, credentialValues })`.
3. `server/src/services/tool-access.ts:2800–2925` — server-side `connectGalleryApp`: when called with `input.link` (no `galleryKey`), it creates a `remote_http` connection with `{ url: input.link }`, persists optional `credentials.authorization` as a Bearer header secret, and lands the user on the standard actions step.
4. `server/src/services/tool-access.ts:1797–1827` — `remoteTools()`: catalog discovery posts `tools/list` to that URL with the resolved headers, surfaces 401/Bearer challenges as friendly "needs you to sign in" copy, and any other non-OK as `502 Remote app returned an error`.
5. `server/src/services/tool-access.ts:1873–1910` — `checkConnectionHealth`: re-runs `tools/list`, writes `healthStatus` + `healthMessage`, audits success/failure.
6. `ui/src/pages/apps/AppDetail.tsx:283–324`, `app-detail/AdvancedPanel.tsx:91,126,137` — the App page already renders `healthStatus`/`healthMessage` via the reconnect card and Advanced panel; attention states gate `needsReconnect`.
7. `ui/src/pages/tools/PasteConfigTab.tsx` and `server/src/services/tool-access.ts:4678–4722` — Advanced "Paste a config" tab accepts `mcpServers[*].url` and produces a `remote_http` draft preview.

## End-to-end path for the KV demo (no UI changes required)

A developer who runs the KV demo MCP server (`packages/kv-demo-mcp-server`, listens on `http://127.0.0.1:8848/mcp`) can connect it in three clicks:

1. Apps → **Connect an app**.
2. Scroll past the gallery to "Connect with a link" → paste `http://127.0.0.1:8848/mcp` → **Continue**.
3. Name = `KV demo` (auto-fills to host). "Does it need a key?" → **No** (default) for unauth, or **Yes** + paste `KV_DEMO_TOKEN` for the secured variant. → **Check link**.
4. Server discovers `kv_set`, `kv_get`, `kv_list`, `kv_delete` via `tools/list`. The actions step renders them split into read-only (on by default) and "can make changes" (off by default; `kv_delete` shows the destructive ask-first badge). Pick agents, finish.

Connection health and discovery failures are already surfaced:

- 401 with a Bearer challenge → "This app needs you to sign in" toast (handled today, `tool-access.ts:1814`).
- Network refusal / non-200 → "Couldn't connect / Please check your key" toast on connect; persistent failures render `Needs reconnect` on the App page with `healthMessage`.
- Catalog refresh failures go through the same path on re-discovery (`checkConnectionHealth`).

## Why not a new "Connect remote MCP URL" Advanced tab

Considered and rejected. Reasoning:

- **Hick's Law / Tesler's Law.** A third Advanced tab next to "Run your own" and "Paste a config" would split the URL-only path off from the gallery's link affordance and force the developer to pick between two functionally identical paths. The gallery's link field already does the URL job; redundancy is friction, not clarity.
- **No new server contract.** The gallery link affordance and a hypothetical Advanced URL tab would both POST `connectApp({ link, credentialValues })`. There is no UX gap that justifies a second client of the same endpoint.
- **MCP vocab gate (PAP-10827).** Adding the word "MCP" to an Advanced tab is fine; adding a tab that duplicates an existing screen's job is not.

## Recommended copy / handoff fixes

Three small, surgical changes — none of them require new components or design tokens.

### 1. Gallery link affordance — one-line discoverability hint (PAP-11091)

File: `ui/src/pages/apps/AppsConnect.tsx:471–521`. Today the placeholder is `https://example.com/actions` and the body copy is "Paste a setup link from an app that is not listed here." A developer who has built their own MCP server and wants to point Paperclip at it might not realise this is the right field for them.

Change two things:

- Placeholder: `https://example.com/actions` → `https://example.com/actions  or  http://127.0.0.1:8848/mcp` (use the en-space separator to keep the two examples visually distinct without punctuation).
- Add one line under the existing body copy: "Any remote tool URL works here — including a local MCP server you're running yourself." No new icons or layout changes; this stays under the same `Link2` heading.

Reasoning: prosumer-safe wording ("remote tool URL", "running yourself" instead of "MCP gateway"). The single word "MCP" is intentional and minimal — it's the only term developers searching for confirmation will recognise, and it's already permitted on Advanced surfaces. We are *adjacent* to Advanced here, not deep in the prosumer-only path, so a light reference is acceptable. If Dotta wants stricter vocab gating, swap "MCP server" for "tool server".

### 2. Advanced "Paste a config" tab — redirect hint (PAP-11091)

File: `ui/src/pages/tools/PasteConfigTab.tsx:66–68`. Today the only header copy is "Paste the MCP config snippet from the tool's README and we'll turn it into a friendly setup." A developer who pasted a config snippet but actually only has a URL needs a redirect to the simpler path.

Add one line to the right of the existing helper text:

> Just a URL? Paste it on [Connect an app → Connect with a link](/apps/connect) instead.

Where the `/apps/connect` link routes the user to the gallery step. Pure copy, no layout change.

### 3. KV demo README — point developers at the right path (PAP-11089)

File: `packages/kv-demo-mcp-server/README.md:83–88`. Today the README says:

> Run this server, then add it in Paperclip via Apps → Advanced ("run your own") as a remote HTTP MCP server pointing at `http://127.0.0.1:8848/mcp` (include the token header if `KV_DEMO_TOKEN` is set).

This is wrong. "Run your own" is the **local stdio** tab; the KV demo is `remote_http`. Correct copy:

> Run this server, then add it in Paperclip via **Apps → Connect an app → Connect with a link**, pasting `http://127.0.0.1:8848/mcp`. If `KV_DEMO_TOKEN` is set, toggle "Does it need a key?" to **Yes** and paste the token. Keep the Values UI open in a browser tab to watch tool calls land in real time.

Folded into Phase 6 documentation issue [PAP-11089](/PAP/issues/PAP-11089) — no separate filing needed.

## Out-of-scope UX bug surfaced during review (filed separately)

The Advanced "Paste a config" tab is a **dead-end**: it previews drafts via `POST /tools/mcp/import-json` but provides no button to activate them. The preview text says "Next, you'll add the keys and pick the actions you want on" — there is no Next button. Tracking as [PAP-11092](/PAP/issues/PAP-11092).

## Acceptance criteria coverage for PAP-11088

- ✅ Clear UX decision: the existing prosumer Connect-with-a-link path is the recommended way to connect the KV demo and any `remote_http` MCP URL.
- ✅ Implementation work captured as child / handoff issues: [PAP-11091](/PAP/issues/PAP-11091) for the two copy hints, [PAP-11092](/PAP/issues/PAP-11092) for the dead-end Paste-config preview bug, [PAP-11089](/PAP/issues/PAP-11089) for the README correction.
- ✅ No new screens required, so screenshots/wireframes are not needed for this phase. The recommended copy is concrete and quoted above.
