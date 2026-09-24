# Composio broker retirement

September 21, 2026

Composio now has one Paperclip catalog method: direct MCP. Enable **Settings → Experimental → MCP aggregators**, then connect with Composio Connect or an externally configured MCP session URL and headers. The existing Access → Connect setup, OAuth, permissions, per-action Test, and gateway execution are unchanged. Connect underlying apps in Composio; Paperclip does not create per-app child connections.

The project API-key method, toolkit-management API routes, Services tab, connected-account synchronization, and session-minting broker have been removed. There is no automatic credential or grant migration.

Previously saved broker and child records are retained for inspection and explicit removal. They appear as Retired with replacement guidance, are absent from gateway discovery, and cannot execute or refresh tools, reconnect, or start OAuth. Add a new Composio MCP connection and choose its access rules. Remove each obsolete record using the normal removal action to delete its credentials and revoke its grants. Removing a legacy parent does not automatically remove other saved records.

No database migration or new tables are required. Direct MCP connections are identified separately from the old REST API parent and `provider: composio` child markers, so their existing vault secrets, grants, catalogs, and permissions remain in place.

## Verification

Focused fixtures cover removal of the API-key catalog method and toolkit routes, retirement of stored parent/child records without upstream calls, explicit credential cleanup, rejection of previously discovered child tools, and direct MCP catalog refresh/reconnect with preserved Off/Ask choices and company isolation. Browser acceptance is recorded below after testing the existing live Composio Connect account.

### Live browser regression

Used the existing isolated connector lab with fresh development data, rebuilt UI, and server on the cleanup branch. Opened Connectors → saved Composio → Permissions. Refresh actions returned the same 11 tools with access intact. The ordinary Test dialog ran `COMPOSIO_MANAGE_CONNECTIONS` with GitHub's `list` operation as the test agent; it returned `successful: true`, no provider error, and the account list in 2.0 seconds. No new sign-in or credentials were needed. This exercises the retained OAuth grant and direct MCP gateway, not a mocked provider.

Functional result: catalog refresh and real gateway Test passed. UX result: the existing Permissions/Test flow remained usable and no broker Services tab appeared. This focused regression does not repeat every provider's original acceptance matrix or claim new account authorization.

A fresh real-agent follow-up also passed: `COMPOSIO_SEARCH_TOOLS` discovered `DEEPWIKI_MCP_READ_WIKI_STRUCTURE`, then `COMPOSIO_MULTI_EXECUTE_TOOL` returned the Paperclip documentation hierarchy (13 top-level sections, 62 subsections; one success, zero errors). The gateway audit independently records both invocations as succeeded on the new run. No provider accounts were modified. Server/UI typechecks, token gates, UI build, Storybook build, and the focused tests passed; the full local suite was intentionally not run.

The retired-record UI was also exercised with a disposable, credential-free legacy fixture in the isolated lab. The list showed Retired rather than Paused; details displayed replacement/removal guidance without obsolete runtime controls. Add Composio MCP connection opened the normal Access → Connect flow with the direct MCP URL and authentication fields. The fixture was removed through the normal confirmation UI afterward.
