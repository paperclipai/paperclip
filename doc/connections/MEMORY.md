# Experimental memory connectors

Enable **Settings → Experimental → Memory connectors**, then open **Connectors**
and choose Mem0, Zep, Supermemory, Cognee, or Honcho. The flag defaults to off.
It hides catalog setup and rejects new curated setup and initial OAuth-start
requests on the server. Existing connections keep running and can reconnect or
rotate credentials without re-enabling the toggle.
Generic custom MCP connections retain their existing behavior.

These are ordinary company-scoped tool connections. There is no separate memory
page, automatic conversation upload, prompt injection, or background memory sync.
Agents explicitly invoke the provider's tools through the existing gateway, and
operators manage access and actions on the regular Permissions screen.

## Provider contracts

Official documentation and public endpoint discovery checked September 24, 2026.

| Provider | Transport and authentication | Setup and scope |
| --- | --- | --- |
| [Mem0](https://docs.mem0.ai/platform/mem0-mcp) | Remote MCP, `https://mcp.mem0.ai/mcp/`, Bearer API key | Create a key in the Mem0 dashboard. The provider key controls project access; user/agent/session selectors are tool arguments. |
| [Zep](https://help.getzep.com/memory-mcp-server) | Remote MCP, `https://api.getzep.com/mcp`, OAuth | Configure Memory MCP and the identity provider in Zep first. A project administrator assigns MCP seats and shared graphs. Sign in with the assigned work identity. An ordinary Zep API key is not the credential for this endpoint. |
| [Supermemory](https://supermemory.ai/docs/supermemory-mcp/mcp) | Remote MCP, `https://mcp.supermemory.ai/mcp`, OAuth | Sign in and select the workspace, read/write access, and optional container tags offered by Supermemory. Developer API keys are separate from hosted MCP sign-in. |
| [Cognee](https://docs.cognee.ai/cognee-cloud/connections/cloud-mcp) | Bundled Cloud API bridge, Cloud API key | Copy the tenant API Base URL and key from Cognee Cloud → API Keys. Requires an active Cloud workspace. The bundled bridge works in public deployments without a local MCP runtime host. |
| [Honcho](https://honcho.dev/docs/v3/guides/integrations/mcp) | Remote MCP, `https://mcp.honcho.dev`, Bearer API key | Create an organization and API key in the Honcho dashboard. Workspace, peer, and session selectors remain explicit provider tool arguments. |

Zep and Supermemory use user grants, the existing PKCE OAuth broker, and automatic
client registration/discovery. Zep advertises its authorization server at
`https://api.getzep.com/v1/oauth`, with `graph:read graph:write` scopes.
Supermemory advertises `https://api.supermemory.ai/api/auth`, with
`openid profile email offline_access`. Neither requires Paperclip ID or a new
Paperclip-hosted credential service.

Cognee does not advertise a hosted MCP endpoint. Paperclip bundles a narrow
Cloud API bridge for `remember`, `recall`, and `forget`, matching the reviewed
remote-mode contract from `cognee-mcp` 0.5.5. The existing approved template ID
and credential paths remain compatible, but no process or package manager runs:
there is no runtime registry resolution, transitive dependency installation, or
credential-bearing subprocess or local runtime slot. Provider failures do not
consume local restart budgets. The bridge uses the gateway's guarded HTTP
client and bounded response reader. It sends credentials only to the validated
HTTPS tenant origin under `*.aws.cognee.ai`; redirects, credentials in URLs,
ports, paths, query strings, and fragments are rejected.

Setup validates Cloud access with the datasets endpoint. Scheduled health
checks validate the URL and vault references without probing the Cloud API, so
a transient provider timeout cannot hide working tools. Actual calls still
report provider failures. Calls without an explicit timeout receive 60 seconds
for retrieval synthesis. Indexing is asynchronous, so an immediate recall after
remember may return HTTP 409 until the dataset is ready.

## Credential and governance boundaries

API keys and OAuth tokens use the instance vault and existing grant lifecycle.
Cognee's tenant URL is displayed as text during entry but is also vaulted, with
an `env.COGNEE_BASE_URL` reference. No credential value belongs in connection
config, manifests, logs, fixtures, or Storybook. Personal credentials stay on
personal grants; organization credentials stay on the organization grant.
The local stdio gateway projects only the approved template's environment keys.

Provider resource selectors are not new Paperclip-enforced tenant filters. The
provider's key, OAuth consent, and ACLs determine its accessible data. Configure
agent access and action policies accordingly; do not claim that a user ID,
workspace name, dataset, or space argument by itself enforces isolation.

The catalog classifies memory retrieval as read, storage/update as write, and
forget/delete/reset as destructive, overriding misleading read-only hints.
Unknown actions are treated as writes. Supermemory's `add_memory` can either
save or forget, so the whole action is destructive. Cognee exposes only the
reviewed `remember`, `recall`, and `forget` schemas from version 0.5.5, not the
package's broader administration tools.

| Reviewed family | Examples | Risk |
| --- | --- | --- |
| Retrieval | Mem0 `search_memories`, `get_memories`, `list_events`; Supermemory `search_memory`, `get_profile`; Cognee `recall` | Read |
| Store/update | Mem0 `add_memory`, `update_memory`; Zep add-memory tools; Cognee `remember`; Honcho create/update tools | Write |
| Delete/forget | Mem0 `delete_memory`, `delete_all_memories`, `delete_entities`; Supermemory `add_memory`; Cognee `forget` | Destructive |

The existing default policy remains **Allowed** for active actions, including
writes and deletion. Operators can narrow access or set **Ask first**. Connection
revocation, company and grant checks, action profiles, runtime access, catalog
quarantine (when enabled), and audit continue through the shared substrate.

## Review and validation

Storybook: **Apps → Connections → Memory**. Includes all five production setup
flows, the experimental toggle, disabled setup, waiting for sign-in, rejected
credentials/retry, and a narrow Cognee layout. The fixtures explicitly simulate
authentication/discovery and never call providers or store secrets.

Deterministic tests cover the off-by-default contract, cached gallery filtering,
direct setup links, server-side gates before secret creation, provider methods,
environment credential paths, risk classification, pinned Cognee schemas, URL
restrictions, and encrypted credential handling. Full provider proof is tracked
separately below; mocked tests and Storybook are not live proof.

The [sanitized live tool inventory](memory-tool-inventory.json) records every
discovered name, schema hash, parameter name, and risk classification for the
five connected providers (82 tools total).

Live observations from the isolated `codex/memory-connectors` checkout:

- Mem0: API key created; live setup discovered 11 tools. Search succeeded through
  Paperclip. An `add_memory` call with synthetic notebook text waited for **Ask
  first**, then executed after **Allow once**, with both decisions in the audit log.
- Supermemory: Google sign-in and developer API key creation completed. Hosted
  MCP OAuth connected separately with read-only consent restricted to the test
  tag and one test agent. Search succeeded; a query for an unconsented tag
  returned the expected provider denial. Live discovery returned 16 tools.
- Cognee: API key created and Cloud access verified. The official pinned MCP
  client stored synthetic notebook text in a dedicated test dataset and recalled
  it after indexing completed. Personal setup exposes the three reviewed tools.
  Paperclip gateway recall returned the expected blue notebook fact (10.6s).
  A nonexistent test dataset returned a tool error, correctly recorded as failure.
- Zep: Google signup and the isolated `Memory connector test` project are ready.
  Its project API key is saved in `~/.secrets` (mode 0600), separately from the
  hosted MCP OAuth grant. Enabled Google Workspace MCP with writes allowed and
  automatic user creation disabled; created only the matching test user using
  the documented API. Paperclip dynamic registration and the explicitly approved
  `graph:read` / `graph:write` grant completed. Live discovery returned 12 tools.
  The Codex browser's automated form submission stalled; a fresh flow and the
  user's final consent click completed authorization.
- Honcho: initial organization creation failed repeatedly, including after a
  fresh Google login. A subsequent retry succeeded and issued the API key,
  saved in `~/.secrets` (mode 0600). Personal connection setup discovered 40 tools.
  No payment method was added. The real agent test exposed and verified the
  personal remote credential-path correction described below.

All five providers now have authenticated managed-tool E2E evidence. Supermemory
now also has verified scoped writes and semantic recall, as recorded below. Discovery does
not establish that every individual tool or advanced provider feature was tested.
No real memories were uploaded for testing. The synthetic Cognee dataset is
`paperclip_memory_connector_smoke_20260924`; the Mem0 test user and Supermemory
consent tag are `paperclip-memory-smoke-20260924`.

### Real agent tasks

Follow-up acceptance testing creates tasks in the browser and assigns a real
`codex_local` agent in an isolated company. These tests use managed connector
tools, not provider credentials in the agent environment. Task-scoped connector
audit records verify the returned provider results independently of the agent's
completion comment.

The first task exposed a Codex delivery defect: generated MCP config used
`headers`, which Codex ignores, instead of `http_headers`. The adapter now writes
the supported field; a regression assertion checks the complete header setting.
After restarting the test server, the resumed agent received working managed
tools and retrieved the approved Mem0 memory.

- **MEM-1 / Mem0:** browser-created task requested a synthetic write, paused for
  **Ask first**, and resumed after the board clicked **Approve & run**. The write
  executed once and `search_memories` retrieved the same memory ID and exact
  silver compass fact under user `paperclip-memory-task-e2e-20260924`.
- **MEM-2 / Cognee:** the task called `remember` and `recall` through the managed
  stdio gateway. The provider returned the amber telescope fact from dedicated
  dataset `paperclip_memory_task_e2e_20260924` on the first recall.
- **MEM-3 / Supermemory:** read-only search succeeded within the consented tag
  with an honest zero-result response; one out-of-scope search returned the
  provider's explicit 403 denial. This does not test memory writes under
  read-only consent. The task exposed a gateway reporting defect: provider
  `isError: true` was recorded and returned as success. Failed provider calls now
  produce failed invocation/audit records and an MCP `isError: true` response.
  A second browser-triggered agent run confirmed both the successful scoped
  search and the corrected error response; audit records show `call_failed`,
  `outcome: failure`, and `reasonCode: tool_error` for the denied search.
- **MEM-4 / Zep:** run `959d37a2-5d06-4f8b-bbfd-b4d751949fc8` called
  `add_memory` and `search_graph` through the managed connector. The first
  episode search returned the exact golden astrolabe fact and matching episode
  `9133fe20-3bf0-46e4-bb48-d58c697d141d`. The episode was not yet processed;
  raw episode retrieval passed, while derived graph processing is not claimed.
- **MEM-5 / Honcho:** the first authenticated run exposed a gateway bug: a
  personal API-key path `credentials.authorization` was incorrectly prefixed a
  second time during vault resolution. Personal remote grants now use their
  declared path, with regression coverage for API keys, custom headers, and
  OAuth. After restart, run `f8498aa1-5c84-48f5-8a94-3b603ea30e9a` made seven
  successful managed calls: list/create workspace, create peer/session, add the
  peer, add a message, and retrieve messages. Dedicated workspace
  `paperclip-memory-e2e-20260924`, peer `synthetic-test-explorer`, session
  `synthetic-observatory-session`, message `q3nOttElad3g_JACmizQd` returned the
  exact violet sundial fact. No approval or provider errors occurred on the
  successful run. Its initial discovery still reflected the earlier failed
  health check; successful calls restored connection health.

All tools default to **Allowed**, including writes and destructive actions.
The temporary Mem0 **Ask first** test override was removed after the approval
test. Effective agent access was checked again: Mem0 11/11, Cognee 3/3,
Supermemory 16/16, Zep 12/12, and Honcho 40/40 allowed, with zero ask-first or
off actions. Provider OAuth consent remains a separate boundary from Paperclip
tool permissions.

### Daytona sandbox verification (September 24, 2026)

Browser-created **MEM-6** runs the same three connected providers through a
native `paperclip_runner` Codex agent in a real Daytona Linux x86_64 sandbox.
The acceptance task uses only synthetic data and managed tools: a Mem0 copper
lantern fact, a dedicated Cognee dataset, and Supermemory searches inside and
outside the existing read-only consent. This first run predates Zep and Honcho
account setup; their subsequent local proof appears above. This is a manual
Product E2E attempt, not a full eval campaign.

The immutable sandbox image is
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:b782947dc9738038570308686858dfb37fd731aba2f82944b6bb665a419e2f24`.
The remote runner binary was extracted from that image (SHA-256
`5067194e4a4eff0946e312b162e78a46184dae49c29f5699be81fec6cfd0b9d7`).
The first attempt failed before provider startup because a macOS host needs
`PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` pointing to a Linux binary. After configuring
it, PRP authenticated through Daytona provider ingress and the agent executed in
`/home/daytona/paperclip-workspace` as the `daytona` user.

That retry did **not** pass connector acceptance: its assigned MCP URL pointed to
the local host's loopback address, which means the sandbox itself when used
remotely. No memory provider calls ran. Catalog readiness from
`connections_search` does not prove remote gateway connectivity. Native assigned
MCP traffic uses a direct HTTP connection, separate from the PRP control channel;
the remote Codex path now relays assigned tools through the existing authenticated
PRP dynamic-tool channel. The control plane retains the short-lived gateway token
and invokes the same gateway service for discovery and each call. Provider
credentials, policies, approval checks, and audit records stay server-owned.
Every call also verifies the native run still owns its task; planning/ask modes
expose only read tools. Other provider/local paths retain their existing HTTP MCP
delivery. No tunnel or public board/API exposure is needed for remote Codex.
Provider threads retain dynamic-tool declarations, so the remote session contract
also rotates when introducing the relay. An intermediate retry discovered all
30 tools server-side but resumed an old provider catalog; it made no provider
calls and is not counted as a pass.

The first successful browser-triggered run `16c288bc-27c3-4010-b8f8-e3d24d007c59` completed
**MEM-6** successfully in 1m 36s with the default configured `gpt-5.6-sol` model.
Task-scoped gateway audit records independently confirm six calls:

- Mem0 `add_memory` stored the exact copper lantern fact with `infer=false`;
  `search_memories` returned the same ID (`ba30eea2-f68b-4873-acbe-a59dae98ed75`)
  under user `paperclip-memory-daytona-e2e-20260924`.
- Cognee `remember` accepted the dedicated
  `paperclip_memory_daytona_e2e_20260924` dataset, and `recall` returned the fact
  on the first attempt. Its stdio provider process remains on the control plane;
  the Daytona agent calls it through PRP.
- Supermemory `search_memory` succeeded within the existing consented tag with
  zero results. Exactly one unconsented search returned the expected 403 scope
  restriction and was audited as `call_failed` / `tool_error`.

No approval prompts, public tunnel, direct provider API fallback, or provider
credentials in the agent environment were used. All assigned tools remain
Allowed. This proves the connected Mem0, Cognee, and Supermemory journeys on
remote native Codex; it does not establish live Zep/Honcho access or Supermemory
writes beyond its existing read-only consent. Failed setup attempts are retained
in the task history. The disposable environment is removed after verification.

After Zep and Honcho onboarding completed, **MEM-6** ran again in a fresh
Daytona sandbox: `b41a45a5-6040-429d-82f3-f048f45205a8`, 2m 4s. The browser
showed Done, and task-scoped gateway audit independently confirmed **10
successful provider calls across all five providers**:

- Mem0 retrieved the existing copper lantern memory and matching ID.
- Cognee performed two read-only recalls; the second returned the exact stored
  sentence from the dedicated dataset.
- Supermemory completed a search within the existing consented tag (zero results).
- Zep stored the jade sextant fact once and retrieved its exact text through
  episode search, with matching UUID `8ef23967-bc98-410e-9e06-03669da5d7dd`.
- Honcho created session `daytona-memory-final-20260924` in the existing synthetic
  workspace, added the test peer, stored the ivory compass fact, and retrieved
  the exact message `e7g4wGXfWR5_rdb4bk6zN`.

The agent confirmed Linux x86_64, user `daytona`, and working directory
`/home/daytona/paperclip-workspace`. No unexpected approval or connector error
occurred. The control plane relayed all managed provider calls through the native
runner channel, with no provider keys in the agent environment or public tunnel.
All five connections finished healthy. The original local test-agent configuration
was restored, the disposable environment removed, and Daytona confirmed sandbox
`682ca187-765e-4b61-9038-747d2649e76a` no longer exists. Provider test memories
remain available for inspection. Supermemory writes and advanced derived-memory
features remain outside this test's coverage.

### Storybook walkthrough checks

The Memory group includes 21 stories covering the catalog, experimental switch,
all five setup flows, credential forms, OAuth waiting/failure, completion, and
narrow layouts. Zep and Supermemory now fetch identity fixtures after mount;
preseeded query-cache data previously left their “Which humans” step waiting
forever. Browser walkthroughs reach both providers' ready screens with all tools
allowed. Credential play functions wait for the access button to become enabled;
browser checks also confirmed rejected Mem0 credentials and narrow Cognee inputs.
These are simulated provider journeys and do not replace live account tests.

### Automated checks

- `pnpm -r typecheck` and `pnpm build` passed. The final server changes also
  passed `tsc --noEmit`.
- Connector service, memory governance, and instance-setting regressions: 399
  tests passed with embedded PostgreSQL enabled.
- Focused shared/UI contract and setup tests: 281 passed.
- Storybook production build, token gates, brand asset validation, and
  `git diff --check` passed. Browser review covered both themes, the 320px
  Storybook viewport, disabled setup, the toggle, OAuth waiting, and rejected-key
  retry. Storybook authentication remains simulated.
- The full repository suite finished: 686 files passed, six failed, four skipped;
  13,308 tests passed, 11 failed, 84 skipped. It reported failures in Slack
  callback batching, concurrent workspace port allocation, and deferred heartbeat
  comment batching. Initial connector count/error and instance-setting snapshot
  failures were corrected and their full targeted suites passed. That run also
  loaded memory-normalization code before the final implementation was saved;
  the final targeted memory suite passed. The full suite is not claimed green.
- Codex managed-home regression suite: 53 passed after the live-task fix;
  adapter typecheck and build passed.
- Gateway acceptance/service regression suites: 106 passed after the personal
  remote credential-path fix; final server typecheck and build passed.
- Native relay/session/authority regressions: 534 passed, followed by 36 final
  relay/authority checks covering readable tool names and live task-mode changes.
  Final server typecheck and build passed. Relay checks cover configured gateway
  reuse, gateway errors, revocation, partial bindings, credential isolation, and
  planning/ask restrictions.

### Supermemory write completion (September 24)

The original read-only grant was replaced through the browser with a new
read/write OAuth grant restricted to `paperclip-memory-smoke-20260924` and the
same test agent. The old local connection was removed. `who_am_i` independently
returned scoped `permission: write`; all 16 Paperclip tools remain Allowed.

Local run `fb67a991-2960-47e5-8f79-94282c65d2ec` saved the exact synthetic fact
“The Supermemory test navigator keeps a turquoise compass in a maple cabinet.”
Document `zUk5wpBu79rCMWu9Yubd9j` initially stayed queued, so the task correctly
did not claim immediate recall. Supermemory's browser console later displayed
Done and the exact stored content.

Daytona run `bab3abd3-617e-4598-b0de-213d5c26f075` performed a second write:
“The Daytona Supermemory test pilot keeps a coral sextant in a walnut drawer.”
Document `C5HY2CWANHZZa3TckJUDYN` reached Done. Managed `get_document` returned
its exact content; `search_memory` returned both this fact and the earlier
local fact at 93% relevance to their respective queries. The task audit records
10 successful calls, including the write, document reads, and semantic searches.
No provider credentials entered the sandbox. The native PRP relay handled all
calls without a public tunnel. The local agent configuration was restored, and
sandbox `6a9723dd-972e-4933-b227-6b8e7e2133ae` was deleted and verified absent.

### Bundled Cognee bridge acceptance (September 24)

The final implementation was retested after replacing the external MCP client
with the bundled Cloud bridge. Local managed write run
`16e7820c-2a94-41d9-8d7b-abe6524edf01` stored the bronze-telescope fact in
`paperclip_memory_bundled_bridge_20260924`; the immediate recall did not yet
prove indexing completion. Follow-up run `8e12cad1-f2f4-4471-a790-d589ffa050b7`
returned “He keeps a bronze telescope in a birch observatory.”

Final Daytona run `a56f9f97-3fb3-498c-abf6-974ddc7d5d30` independently recalled
that fact, then stored “The Daytona Cognee test cartographer keeps a silver
globe in a cedar study.” in `paperclip_memory_daytona_bridge_20260924`.
The provider returned dataset `9518ab46-e777-5f38-994b-9ceabfff4856`, then graph
recall returned the silver globe and cedar study. Every call used the native
runner relay and reported `transport: cognee_cloud`, `spawnedLocalProcess: false`.
The run succeeded. No provider credentials entered the sandbox. The original
local agent configuration was restored, and sandbox
`3b980bc0-6bcd-4cfe-9b17-b518c1aed64a` was deleted and verified absent.

The gateway regression suite passed all 71 tests, including immediate recovery
from a provider error in an authenticated public deployment without a trusted
local runtime host. The regression asserts that no runtime slot is created.
The bundled bridge's 25 contract and validation tests also passed.

## Branding provenance

Official artwork downloaded September 24, 2026; no invented marks or colors:

- Zep: `https://www.getzep.com/apple-touch-icon.png` (official gradient mark).
- Supermemory: `https://supermemory.ai/apple-touch-icon.png?v=2` (official mark on
  its supplied white background).
- Cognee: `https://www.cognee.ai/favicon.ico`, converted losslessly to PNG.
- Honcho: `https://honcho.dev/Honcho_Pixel-05.svg`.
- Mem0 reuses the existing catalog artwork.

The supplied square artwork fits the shared gray connector frame and works in
both themes. Registry changes are in `ui/public/brands/apps/manifest.json`;
regenerate definitions with `node scripts/ingest-app-definitions.mjs --definitions-only`.
