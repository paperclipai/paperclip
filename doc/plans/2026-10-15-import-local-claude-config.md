# Import model providers from the operator's local Claude configuration

Date: 2026-10-15
Status: Implemented. Submitted with PR "feat(ai-connections): import model providers from local Claude configuration".

## Summary

Paperclip gives a new operator two ways to connect a model: a subscription login,
which reads the local Claude login but still drives the official endpoint, and an
API key, which the server validates against `api.anthropic.com`. An operator who
already runs `claude` against a third-party gateway has neither: the gateway
address has nowhere to go, and the gateway key is rejected by the official
endpoint. This change adds a third credential mode. The mode reads the operator's
own `~/.claude/settings.json`, shows a confirmation card with a masked key, probes
the gateway once, and creates an ordinary managed AI connection that carries the
gateway endpoint.

## Problem

The gateway address, key, and model tiers already exist in
`~/.claude/settings.json` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_*_MODEL`). The operator retypes all of
it by hand, or cannot use the gateway at all. The endpoint today is implied by
the provider; this change makes it a field on the connection.

## Scope

- A third credential mode (`import`) on four surfaces: the onboarding connect
  step, the new-agent wizard, the agent configuration page, and the Apps catalog
  connect/reconnect flow. Three of the four share one component, so one change
  covers them.
- Two new routes under `ai-connections`: a read route and an import route.
- Runtime injection reads the endpoint from the selected connection.
- No database migration. The new fields land in the existing `config.ai` JSON.
- The mode renders only for Claude-family adapters on a `local_trusted`
  instance, and only for the local operator. The server enforces both gates
  again on each route; the UI only avoids drawing a control nobody can finish.

## Design decisions

1. **The endpoint is a connection field, not a new provider value.**
   `config.ai` gains optional `baseUrl`, `keyVariable`, and `models`. The
   provider stays `anthropic`. A new provider value would force CHECK-constraint
   migrations on two tables and touch the capability map, compatibility checks,
   app-gallery rows, and two provider-to-adapter maps. A field migration costs
   nothing and leaves every existing compatibility judgement intact. A
   `superRefine` keeps the fields meaningful only for Anthropic API-key
   connections.

2. **The connection remembers which variable its key came from.**
   `ANTHROPIC_API_KEY` travels as `x-api-key`; `ANTHROPIC_AUTH_TOKEN` travels as
   `Authorization: Bearer`. Injecting a token under the wrong variable fails
   with 401 on gateways that read only one. The connection records the variable
   name, and the runtime injects under that name.

3. **The server reads the file; the client never supplies credentials.**
   The client sends only a non-secret summary for comparison. The import route
   re-reads the file and compares field by field, and refuses with "the local
   configuration changed" when they differ. The existing rule that credentials
   never travel to a caller-supplied URL stays a structural guarantee, not a
   validation rule.

4. **Runtime injection appends to the blanking pass.**
   `prepareManagedAiRuntime()` already blanks `AI_AUTH_ENV_KEYS` and writes the
   managed credential. After that, a connection with an endpoint sets
   `ANTHROPIC_BASE_URL`, injects the key under its recorded variable, blanks the
   other one, and injects `ANTHROPIC_MODEL` from the resolved tier when the agent
   has no explicit model. The endpoint and the tier join both session
   fingerprints, so a re-import onto another gateway cannot resume a session
   that ran against the old one.

5. **Two gates, neither optional.** Instance level: `supportsLocalAiLogin()`,
   the same gate the subscription login uses. Operator level: the actor must be
   the local implicit identity, the same requirement the subscription path
   already applies when it reads local credentials. Without the second gate, any
   board user could copy the operator's gateway key into a personal connection.

6. **Reachability is judged at import time.** The probe runs on the Paperclip
   server, so success proves the server can reach the gateway, not that the
   agent's execution environment can. An import for an agent whose environment
   is not local (sandbox, SSH, Kubernetes) is refused, as is an import whose
   gateway host sits outside an agent's network allowlist. A connection imported
   for one locally executed agent stays usable by another.

7. **An unchanged re-import does not rotate the secret.** The secret version
   feeds the run's session identity, so a rotation aborts runs already in
   flight. The import route compares the stored credential and skips the
   rotation when the value is byte-identical.

8. **The project auth scan stops at the operator's home directory.**
   `assertManagedAiProjectAuth()` walks up from the workspace and rejects a
   workspace whose `.claude/settings.json` carries provider keys. Reaching into
   the operator's home would block every task for exactly the users this feature
   serves, because the managed runtime replaces `HOME` with a temporary
   directory and never reads that file. The scan still covers workspaces, so the
   guard keeps its purpose. This is a behavior change outside the feature and
   belongs in the release notes.

## Verification

Server tests run against real PGlite with a mocked fetch, and cover: the
seven-key read whitelist; the six classified read failures; key-variable
priority; both gates on both routes for all four surfaces; the reachability
refusals; URL normalization (trailing slash, `/v1`, `/v1/v1` all fold to one
value); the read-versus-import comparison; probe outcomes including 401/403
with no half-built connection; the stored endpoint and variable; runtime
injection with the other key variable blanked; the unchanged re-import that
mints no secret version; the second validation entry point probing the gateway
instead of the official endpoint; usage queries that stay on the connection's
own endpoint; and the unchanged refusal of a hand-written `ANTHROPIC_BASE_URL`.

UI tests live in their own files, because the existing suites either share
heavy mocks or mock the credential step away. They cover: the mode appears only
for Claude adapters on a supported instance; the card never shows a plaintext
key; keyboard semantics of the mode tiles; and Esc as cancel.

End-to-end, a local fake gateway that records headers proves the import path
under both key variables, and the release smoke path confirms the onboarding
API-key route is unharmed.

## Risks

- **The second validation entry point.** `probeManagedEnvironment()` validates a
  managed API key against the official endpoint. A connection with a custom
  endpoint must be verified on that endpoint instead, or adoption always reports
  a rejected key. Covered by a test.
- **In-flight runs on re-import.** When the credential value changes, the
  session identity changes and suspended native runs restart. Runs already
  executing finish. The unchanged-value case is removed by decision 7; the
  changed-value case is documented behavior.
- **Plaintext HTTP to a non-loopback host.** Accepted trade-off, limited to
  local-trusted instances. The card shows the protocol and host unchanged.
- **Model list and connection endpoint can disagree.** The model dropdown is
  discovered from the server process environment, not from the connection. A
  connection pointing at gateway B can list gateway A's models. Out of scope
  here; the operator can type a model ID by hand. A later change can make the
  dropdown use the selected connection's endpoint.
