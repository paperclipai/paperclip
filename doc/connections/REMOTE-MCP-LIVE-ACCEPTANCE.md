# Independent MCP connectors — acceptance, 2026-09-21

Worktree: `codex/unified-mcp-connectors`, based on `b19307758`. Local instance: [MCP Connector Lab](http://127.0.0.1:3116/MCP/apps). Fresh database/company; no production data was cloned. The API serves this worktree's compiled UI on port 3116, with browser-reachable localhost OAuth callbacks. Instance data is isolated under `~/.paperclip-worktrees/instances/unified-mcp-connectors-live`. Static UI serving avoids a local Vite watcher startup problem.

**Overall acceptance remains incomplete: Zapier needs the generated credential pasted into its open local setup form.** Three providers have real browser and real agent proof. Simulations are recorded separately below.

## Experimental rollout

Setup is behind **Settings → Experimental → MCP aggregators** (`enableMcpAggregators`). It defaults off on self-hosted and managed instances. When off, all four fresh catalog entries are hidden and direct setup, reconnect setup, and OAuth-start requests are rejected server-side. Existing connections keep running and remain available for management. Legacy Composio API-key/child connections are unchanged. An in-progress OAuth callback may complete; the flag does not revoke already issued credentials or grants.

Focused regression tests cover flag defaults, persistence, managed metadata, cached catalog visibility, all four direct setup routes, and server-side rejection before network/credential writes.

## Live results

| Provider | Functional correctness | UX readiness | Observed account, catalog, and actual results |
| --- | --- | --- | --- |
| Arcade | Passed OAuth setup, Test, real agent, Off, Ask first, denied agent, catalog additions/removal, reconnect, disconnect, and restoration. | Ready for the tested gateway OAuth flow after the fixes below. | Dedicated “Paperclip connector lab” gateway; GitHub account `cryppadotta`. Started with 4 exposed tools, added two read actions, then removed one (5 remain). `Github.GetRepository` returned `paperclipai/paperclip`, branch `master`, repository ID `1170821064`. |
| Composio | Passed default endpoint OAuth, Test, real agent, Off, Ask first, denied agent, refresh, reconnect, disconnect, and restoration. | Ready for Composio Connect. Optional GitHub app consent remains at GitHub's user-verification screen; this does not block the verified DeepWiki action. | Signed in as `dotta@paperclip.ing`; 11 meta tools. Search discovered `DEEPWIKI_MCP_READ_WIKI_STRUCTURE`; Multi Execute returned the real Paperclip documentation hierarchy, 1 success / 0 errors. The real agent repeated discovery and execution. |
| Executor | Passed workspace OAuth, Test, real agent, Off, Ask first, denied agent, refresh, reconnect, disconnect, and restoration. Provider approve/resume, decline, cancel, and Paperclip approval → provider approval were exercised. | Ready for the tested hosted workspace with model-side resume. Decline/cancel copy now describes the deliberate outcome rather than suggesting a retry. | Workspace `paperclip`, signed in as `dotta@paperclip.ing`; 7 tools. Execution returned integration slugs `executor`, `context7`. A disposable Context7 read paused for approval; resuming the same execution returned real React library IDs. |
| Zapier | Live proof blocked after provider setup; production integration and deterministic tests are implemented. | Approved setup design and Storybook checks pass. Real URL-paste workflow still needs completion. | Created a dedicated Managed-mode server with Google Sheets Find Spreadsheet / Get Spreadsheet by ID, using the existing `dotta@paperclip.ing` account. Its generated credential is masked. Copy buttons returned an empty clipboard through automation. No Paperclip credential has been entered or live tool call made. |

The real Paperclip agent uses a separately vaulted Anthropic API key from the user-authorized local secrets file. No secret value is stored in this report or the source tree.

### Agent evidence

- [MCP-1](http://127.0.0.1:3116/MCP/issues/MCP-1): six real gateway calls; Arcade repository read and Executor skills → search → integrations list.
- [MCP-2](http://127.0.0.1:3116/MCP/issues/MCP-2): Composio discovery and DeepWiki execution returned actual headings including Overview, Core Concepts, Getting Started, Server Architecture, and User Interface. Arcade's Off tool was absent from callable discovery. Executor public helper paths were readable and executable.
- [MCP-3](http://127.0.0.1:3116/MCP/issues/MCP-3): disconnected Arcade exposed no tools; ungranted Composio exposed no tools and reported that identity/access needed review. Executor remained available and returned its actual integration list. This verifies cross-connection isolation through a real agent.

### Governance and lifecycle evidence

- Arcade CountStargazers Off prevented a Test call and disappeared from the real agent's tool surface. GetRepository Ask first made no call until “Allow once”; the saved Test result then showed the actual repository response.
- Composio Multi Execute Off prevented Test execution. Search Ask first completed only after Paperclip review. Removing all agent access made Search Off despite its saved Ask first choice.
- Executor skills Off prevented testing. Removing agent access also prevented execute despite an Ask first choice. A separately allowed execution paused at the provider, preserving its execution ID. Inline acceptance resumed that ID; decline and cancel each stopped their respective execution. Paperclip Ask first → Allow once → provider pending survived navigation to Review and back.
- Arcade catalog refresh enabled newly added GetFileContents and GetIssue automatically, preserved CountStargazers Off and GetRepository Ask first, and removed GetIssue after its removal upstream. Composio/Executor refreshes retained their stable catalogs and rules. Provider-controlled additions to Composio's meta catalog were not manufactured; changed-catalog fixtures cover the common path.
- All three OAuth reconnects retained an empty agent selection and existing Off/Ask first choices. Reloaded screens agreed with effective Test access.
- Disconnected each through the real UI. Subsequent requests for previously valid Test actions returned HTTP 404 `tool_not_found` for all three. Reconnected through Apps and verified fresh Arcade repository, Composio search, and Executor skills calls. The three connections are left connected with default permissions for review.
- Removed the temporary Executor `context7.*` approval policy after testing. The dedicated test gateway, Zapier server, and Context7 connection remain available for review. Existing unrelated provider configurations were not changed.

## Defects found, fixed, and retested

1. Enabled DCR ownership for direct MCP OAuth; Composio no longer incorrectly requires a configured client ID.
2. Added explicit provider authorization/approval states, validated handoff links, execution identifiers, and resume controls. Executor's `resume.content` must be a JSON string; corrected it after an observed provider rejection and retested successfully.
3. Added an object JSON editor for open-ended schemas. Composio's nested `arguments` object was otherwise impossible to enter. The real Multi Execute call passed afterward.
4. Corrected broad execution risk classification and the false JWT redaction of three exact public Executor helper selectors. Actual secrets, bearer assignments, and arbitrary dotted values retain redaction. MCP-2 verified the selectors live.
5. Prevented app-generated Ask first policies from granting access to an ungranted agent. Negative fixture and live Test/agent checks pass.
6. Allowed an empty selected-agent list and made installation reach plus permission binding updates atomic. OAuth completion no longer substitutes all agents for an empty saved selection. Real reconnects and a dedicated OAuth callback regression pass.
7. Refreshed permission caches with the catalog so newly added tools display Allowed immediately.
8. Retired disappeared tools in stored discovery, not merely the refresh response. Reappearing tools keep existing restrictions. The regression checks persisted database state; the Arcade removal was retested live.
9. Prevented retries of an already-approved provider-pending runtime call from starting another execution. The fixture verifies one dispatch and retained execution identity. Test requires an explicit Reset before starting another approval-controlled call.
10. Added production Reconnect, Manage in provider, and Disconnect controls using the same management component as Storybook. Saved access loading and setup failures remain actionable.

## Supporting checks

All newly added isolated checks passed, with one test worker:

- 27 Vitest checks: protocol (7), provider pending (5), connector lifecycle/governance/OAuth (4), redaction (2), shared contracts (7), schema form (2).
- 18 connector-only Storybook browser checks: four complete setup journeys, four draft/auth journeys, desktop/narrow state matrices, keyboard recovery, Zapier's absence of OAuth, normal Test states, and Executor approve/decline/cancel.
- All 85 connector stories rendered at 1280px/dark and 390px/light without page errors or horizontal overflow. Inspected generated setup and Test screenshots. Evidence is under `tests/storybook-visual/test-results/remote-mcp/` (ignored local test output).
- UI and server direct TypeScript checks, token gates, UI build, Storybook build, and `git diff --check` passed.
- **No full repository test suite, recursive typecheck, or repository-wide build was run**, following the user's resource constraint. No schema migration or lockfile change is included.

Storybook links: [Zapier](http://localhost:6137/?path=/story/apps-connections-zapier--complete-setup-journey), [Arcade](http://localhost:6137/?path=/story/apps-connections-arcade--complete-setup-journey), [Composio](http://localhost:6137/?path=/story/apps-connections-composio--complete-setup-journey), [Executor](http://localhost:6137/?path=/story/apps-connections-executor--complete-setup-journey). [Executor provider handoff](http://localhost:6137/?path=/story/apps-connections-executor--provider-handoff-after-setup) uses mocked responses and makes no real authorization request.

## Remaining work and limits

- Paste Zapier's generated Full URL into the already-open local Zapier setup field (not chat), then complete its browser Test, agent, governance, refresh, and lifecycle acceptance. Do not rotate the displayed credential unnecessarily.
- Optional Composio GitHub account authorization awaits the user's GitHub verification. The no-auth DeepWiki app path is proven; GitHub app execution is not claimed.
- Hosted OAuth paths were tested live. Custom-header/session imports, credential-bearing URLs, protocol URL elicitation, pagination edge cases, and revocation races have deterministic fixture coverage rather than separate live accounts/endpoints for every variant.
- Provider auth links are kept briefly in memory; durable records retain redacted handoff/execution identifiers. After an application restart, a one-time auth link may need reopening from the provider dashboard. Calls are never automatically replayed to recover it.

Completion still requires observed live results for Zapier. Passing stories and fixtures do not substitute for that proof.
