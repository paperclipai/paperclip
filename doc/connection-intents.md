# Connection intents

Connection intents let an agent ask the responsible user for a known service connection without leaving the task thread. The user can reuse an eligible connection or run the normal provider setup in a dialog. A successful resolution grants and installs the connection for the requesting agent, then wakes the task assignee in a fresh run.

## Shared setup flow

`ui/src/features/connections/ConnectionSetupFlow.tsx` is the only connection setup implementation. It owns provider selection, method and identity choices, provider fields, validation, OAuth, access, catalog setup, installs, retry states, and completion. It has two presentation hosts:

- `ui/src/pages/apps/AppsConnect.tsx` supplies full-page routing and breadcrumbs.
- `ui/src/features/connections/ConnectionIntentInteractionBody.tsx` supplies the task dialog, intent resolution, query invalidation, and focus return.

Provider-specific setup must stay in the shared feature and `AppDefinition` metadata. Do not add provider forms or connection mutations to either host.

When a task connection needs Paperclip Cloud enrollment, the shared dialog opens enrollment in a separate window. The task keeps its access selection and interaction ID. A new-tab link is available if the window does not open. The dialog reads server enrollment status and refreshes the provider catalog after approval; enrollment alone does not mark the app connected. OAuth retains the interaction ID even if setup resumes in the page host, so the verified callback can resolve the task card and queue its continuation.

## Agent tools

Every active heartbeat with a responsible user receives two run-bound tools:

- `connections_search({ query })` searches catalog names and descriptions, plus authorized configured MCP connections and indexed tool descriptions and returns `ready`, `needs_user_action`, `available`, or `unavailable` from the requesting agent's perspective.
- `connection_request({ service })` returns immediately when the service is already usable. Otherwise it creates or reuses a `connection_intent` and instructs the agent to finish independent work, then yield pending continuation.

The native Paperclip Runner advertises both tools through its server-owned tool authority even with an empty MCP assignment. It captures the current responsible identity at each call. Legacy Claude and Codex receive the tools through a managed MCP server. Local/process adapters receive `PAPERCLIP_RUNTIME_TOOLS_*` environment variables and CLI guidance. Cloud, HTTP, gateway, and external adapters receive the typed runtime descriptor in their invocation context; compatible adapters may also project it into their remote environment.

Legacy delivery uses the same intent service, setup card, and fresh-session resolution wake. Environment and descriptor delivery require the receiving harness to consume them; they do not establish support in every third-party runtime. The default legacy prompt includes the canonical discovery guidance. A custom `promptTemplate` replaces that default and should retain the connection guidance if proactive discovery is desired.

The equivalent CLI helpers are:

```sh
paperclipai connections search notion
paperclipai connections request notion
```

The manually configured Paperclip MCP server also advertises `connections_search` and `connection_request`. Both helper surfaces require the narrow runtime token and fail outside an active heartbeat.

## Security and lifecycle

- Company, agent, run, task, and responsible user come only from the signed legacy runtime token or the native server-owned binding and stored execution identity.
- Tokens are scoped to connection intents, expire after one hour, and are rejected when the heartbeat is no longer running.
- The thread payload contains only service identity, requesting-agent identity, and a safe phase. It never contains credentials or authorization URLs.
- OAuth state is linked to the interaction. The same-origin callback finalizes the existing connection pipeline, posts only interaction ID/outcome to its opener, and redirects back to the task if there is no opener.
- Personal OAuth defaults to the addressed user and creates an explicit delegation to the requesting agent. Reuse and installs are additive.
- Task-hosted setup locks install reach to the requesting agent; the store host retains its normal broader access choices.
- The intent resolves only after the connection, grant/delegation, profile access, and install succeed. Failures remain pending with `needs_retry`.
- Closing or reassigning the task expires pending intents and deletes linked OAuth state. Ordinary comments and later runs preserve the pending card. Requests reuse the same task, requester, addressed user and service; a different addressed user supersedes an older request for that service.
- Success and explicit decline atomically persist a continuation delivery with resolution. A leased startup/periodic worker dispatches through heartbeat with a unique `connection-intent:<interaction>:<outcome>` wake key. It checks assignment, status, membership and current executable access, retries paused/suppressed delivery, and recovers a crash after enqueue without creating a second wake. The continuation forces a fresh provider session; heartbeat queues it behind active execution.

Legacy `request_confirmation.payload.connectionAuthorization` interactions remain readable and resolvable. New agent requests use `connection_intent` exclusively.

## Model evaluations

The companion `paperclip-evals` repository owns the connection cases in
`evals/runner-api-tools/connection-cases.json`. They use the existing real-server
API-tool eval controller and `scripts/runner-api-eval-worker.ts`, with this
checkout's production tool definitions, connection guidance, and authority.
Natural prompts measure discovery and request selection; explicit contract probes
measure deduplication, readiness, and denied targets. The fixture helper supplies
isolated company records and retains initial and final connection interaction
state. Scoring requires observed calls/results and persisted state, not an
assistant's claim of having connected.

These tool evals do not perform live provider OAuth or establish browser quality.
The native and legacy connection browser suites separately cover setup and
continuation, while the live-provider journey report records actual authorization
and data-read coverage.


## Custom targets, readiness and recovery

Catalog slugs remain stable. Search also returns `connection:<uuid>` for configured custom connections whose active identity grants authorize the responsible person, their company, or the requesting agent. Identifiers are never interpreted as URLs. Configured metadata and tool descriptions, including catalog-provider descriptions, are read only after the company and identity audience checks. Setup choices expose only display and selection metadata; they never include connection configuration, transport settings, or credential fields. Discovery reads the stored index without refreshing providers. Search is ranked with exact provider matches first and capped at 20 results.

`ready` requires an installed, enabled, healthy executable connection, permitted catalog tools, and a usable runtime identity. An installed connection with denied actions is administrative denial rather than a request to reauthenticate. Runtime calls continue enforcing access after a historical card resolves. If access is ready but the native provider's pinned tool snapshot is older, `connection_request` queues a fresh session without another authorization card.

Task setup defaults to personal identity when supported and the requesting agent's install reach. Existing installs are additive. An OAuth callback from a task prepares the catalog without adding access. Intent completion validates the current task and identity, then adds the requesting agent’s binding and install in the resolution transaction. Callback messages do not establish authorization: the card reloads the durable server result. A blocked popup offers a new-tab fallback; closing or declining provider sign-in keeps the request retryable. Only the card's **Not now** action declines the request. Decline continuations are told to pursue alternatives and cannot immediately request the same service again.

## Verification

Service and native-authority tests cover discovery, current identity, company boundaries, cross-run deduplication, additive grants and installs, permission denial, resolution atomicity, restart delivery and stale assignment. `tests/e2e/in-feed-native/playwright.config.ts` starts source `test-drive` instances with fresh data directories and a deterministic fake Codex provider plus MCP server. It exercises the real native runner and gateway; it is fixture proof, not live Notion or GitHub proof. Run with `pnpm exec playwright test -c tests/e2e/in-feed-native/playwright.config.ts`.

Offline Storybook examples live in `ui/storybook/stories/in-feed-connections.stories.tsx`. Build with `pnpm --filter @paperclipai/ui build-storybook`, then run `pnpm exec playwright test -c tests/storybook-visual/in-feed-connections.config.ts`. The suite checks every independently addressable story in both themes, catches play-function failures, and saves screenshots. Live provider acceptance additionally requires a model credential and a test workspace/account; do not describe fixture results or local-trusted testing as authenticated/cloud acceptance.
