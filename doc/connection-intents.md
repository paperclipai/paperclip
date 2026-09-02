# Connection intents

Connection intents let an agent ask the responsible user for a known service connection without leaving the task thread. The user can reuse an eligible connection or run the normal provider setup in a dialog. A successful resolution grants and installs the connection for the requesting agent, then wakes the task assignee in a fresh run.

## Shared setup flow

`ui/src/features/connections/ConnectionSetupFlow.tsx` is the only connection setup implementation. It owns provider selection, method and identity choices, provider fields, validation, OAuth, access, catalog setup, installs, retry states, and completion. It has two presentation hosts:

- `ui/src/pages/apps/AppsConnect.tsx` supplies full-page routing and breadcrumbs.
- `ui/src/features/connections/ConnectionIntentInteractionBody.tsx` supplies the task dialog, intent resolution, query invalidation, and focus return.

Provider-specific setup must stay in the shared feature and `AppDefinition` metadata. Do not add provider forms or connection mutations to either host.

## Agent tools

Every active heartbeat with a responsible user receives two run-bound tools:

- `connections_search({ query })` searches first-party connectable definitions and returns `ready`, `needs_user_action`, `available`, or `unavailable` from the requesting agent's perspective.
- `connection_request({ service })` returns immediately when the service is already usable. Otherwise it creates or reuses a `connection_intent` and instructs the agent to end the run pending continuation.

Claude and Codex receive the tools through a native managed MCP server. Local/process adapters receive `PAPERCLIP_RUNTIME_TOOLS_*` environment variables and CLI guidance. Cloud, HTTP, gateway, and external adapters receive the typed runtime descriptor in their invocation context; compatible adapters may also project it into their remote environment.

The equivalent CLI helpers are:

```sh
paperclipai connections search notion
paperclipai connections request notion
```

The manually configured Paperclip MCP server also advertises `connections_search` and `connection_request`. Both helper surfaces require the narrow runtime token and fail outside an active heartbeat.

## Security and lifecycle

- Company, agent, run, task, and responsible user come only from the signed runtime token and stored heartbeat context.
- Tokens are scoped to connection intents, expire after one hour, and are rejected when the heartbeat is no longer running.
- The thread payload contains only service identity, requesting-agent identity, and a safe phase. It never contains credentials or authorization URLs.
- OAuth state is linked to the interaction. The same-origin callback finalizes the existing connection pipeline, posts only interaction ID/outcome to its opener, and redirects back to the task if there is no opener.
- Personal OAuth defaults to the addressed user and creates an explicit delegation to the requesting agent. Reuse and installs are additive.
- Task-hosted setup locks install reach to the requesting agent; the store host retains its normal broader access choices.
- The intent resolves only after the connection, grant/delegation, profile access, and install succeed. Failures remain pending with `needs_retry`.
- Closing the task, a newer run requesting the same service, or a newer human task comment expires the intent and deletes linked OAuth state.
- Success and decline wake the assignee once using an interaction-and-status idempotency key and force a fresh continuation session.

Legacy `request_confirmation.payload.connectionAuthorization` interactions remain readable and resolvable. New agent requests use `connection_intent` exclusively.
