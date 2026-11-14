# Composio Platform

Use this product when a developer is building an agent, application, or backend whose users connect their own accounts. Route by task instead of assuming every request is onboarding.

## Contents

1. [Choose the task](#choose-the-task)
2. [Establish project access](#establish-project-access)
3. [Integrate sessions](#integrate-sessions)
4. [Choose tools and authentication behavior](#choose-tools-and-authentication-behavior)
5. [Handle advanced product work](#handle-advanced-product-work)
6. [Verify setup when relevant](#verify-setup-when-relevant)
7. [Use canonical documentation](#use-canonical-documentation)

## Choose the task

- **Explain or discover:** answer from this guide and current documentation without changing code.
- **First-time setup:** establish project access and the smallest working SDK path.
- **Integrate or extend:** inspect the codebase and add Composio to the existing agent architecture.
- **Operate:** discover, authorize, and execute tools for the application's current user.
- **Debug or migrate:** inspect the log ID and current implementation before changing credentials or architecture.

When modifying code, first inspect and identify the language, package manager, agent or LLM framework, stable user or tenant ID, secret-loading mechanism, and smallest existing execution path where Composio tools belong. Extend that path; do not create a parallel demo agent when one already exists. Never infer filenames, framework choices, environment behavior, or identity fields that were not provided or observed.

Use progressive disclosure. The basic path is project access, the core SDK, one user-scoped session, and the existing agent's tool interface. Do not add toolkit filters, tag policies, sandbox changes, custom auth, provider adapters, or production hardening unless the request or inspected code requires them. If essential repository context is missing, give the minimum stable outline and ask only for the missing detail instead of filling a large example with placeholders.

## Establish project access

Choose exactly one credential path from context.

### Existing dashboard or repository credential

If `COMPOSIO_API_KEY` already exists, or the developer arrived from Dashboard Getting Started after copying an `ak_*` project key, use that credential from the repository's existing environment or secret mechanism.

In this path:

- Never run `composio dev init` or select another project.
- Never create, rotate, replace, print, echo, log, or request the key in chat.
- Check only whether the environment variable exists and is not visibly masked or placeholder-like.
- When it lives in a file, check that the file is ignored by source control without printing the matching line.
- Let the first SDK request validate the credential; length is not validation.

If the dashboard handoff is missing or masked, direct the developer back to Platform → project → Getting Started → Step 1. Do not silently switch to a provisioning flow.

### General first-time setup

If there is no existing project credential and no dashboard handoff, use the current first-time setup path:

```bash
curl -fsSL https://composio.dev/install | bash
composio login
composio dev init
```

`composio dev init` writes `COMPOSIO_API_KEY` and `COMPOSIO_TEST_USER_ID` to `.env.local`. Python dotenv does not load `.env.local` by default, so pass the path explicitly or move the variables through the project's normal secret mechanism. There is no bare `composio init` command.

Verification stamp: these commands were exercised against CLI 0.2.32 and 0.3.1 on 2026-08-06. If the installed version differs or behavior conflicts, check `composio dev --help` and current docs rather than forcing the stamped behavior.

### Install the SDK the codebase needs

```bash
npm install @composio/core
pip install composio
```

Add a provider adapter only when the existing framework needs one. Fetch the current provider index before naming a package:

```text
https://docs.composio.dev/docs/providers.md
```

Do not introduce another LLM framework solely to demonstrate Composio.

## Integrate sessions

A session is the runtime context for one application user. It carries identity, connections, tool scope, and sandbox configuration.

Trace the application's existing authenticated user or tenant ID and use that stable identifier. Do not add a parallel user system or share one placeholder identity across users.

TypeScript:

```typescript
import { Composio } from "@composio/core";

const composio = new Composio();
const session = await composio.create(existingUserId);
const tools = await session.tools();
```

Python:

```python
from composio import Composio

composio = Composio()
session = composio.create(user_id=existing_user_id)
tools = session.tools()
```

Both SDKs also expose `composio.sessions.create(...)`; do not teach an artificial TypeScript/Python asymmetry. The SDK reads `COMPOSIO_API_KEY` from the environment, so do not pass it inline.

For a multi-turn conversation, persist the returned session ID and resume it instead of creating a fresh session on every message. Confirm current method names against `configuring-sessions.md` before writing production code.

Pass the session tools to the repository's existing model or agent using its native tool integration. Preserve the current prompt, model, streaming, and request lifecycle unless tools require a targeted change.

## Choose tools and authentication behavior

Sessions expose a small set of meta tools by default so the agent can discover integrations and authenticate at runtime:

- `COMPOSIO_SEARCH_TOOLS`
- `COMPOSIO_GET_TOOL_SCHEMAS`
- `COMPOSIO_MULTI_EXECUTE_TOOL`
- `COMPOSIO_MANAGE_CONNECTIONS`
- `COMPOSIO_WAIT_FOR_CONNECTIONS`
- `COMPOSIO_REMOTE_WORKBENCH`
- `COMPOSIO_REMOTE_BASH_TOOL`

Keep connection management enabled for interactive agents. It returns a Connect Link when a user needs to authorize an app; do not build a provider OAuth flow.

Use the direct-tools preset only for a narrow, deterministic agent with a fixed allowlist. It removes meta tools by default. Re-enable connection management when users must authenticate in the agent, and keep or disable the sandbox deliberately. Fetch `configuring-sessions.md` for the current preset and option syntax before implementing it.

If the application has its own connect UI, use session authorization and connection-state methods and suppress in-chat connection prompts. Use managed auth initially. Create a custom auth config only for the application's OAuth branding, additional scopes, dedicated provider quotas, or self-hosted or regional requirements.

## Handle advanced product work

Do not force advanced requests through first-time setup. Route them to current documentation:

- Session scoping, account selection, callbacks, direct tools, and sandbox controls: `configuring-sessions.md`
- Custom connection UI: `manually-authenticating.md`
- Triggers and webhooks: `triggers.md` and the setting-up-triggers guides
- Custom MCP servers, tools, toolkits, or proxy execution: the `extending-sessions` guides
- Legacy direct execution, MCP servers, or Tool Router migrations: the migration and sessions guides
- White labeling and custom OAuth apps: `white-labeling-authentication.md`

"Tool Router" is the former name for sessions. Treat direct execution as a migration path, not the default for new agent integrations.

## Verify setup when relevant

For a first-time setup or integration request, success means a programmatic, safe, read-only tool call from the developer's real execution path returns an actual provider result and a non-empty Composio log ID.

Ask which integration the developer wants to try unless the application already makes the choice clear. Discover the real toolkit and tool at runtime. If the current user is not connected, return the Connect Link, wait for authorization, and retry.

A mock, Playground run, tool search, schema fetch, session creation, or Connect Link alone does not prove the integration. If the repository has no runnable agent loop, add only the smallest entrypoint compatible with its existing provider; do not require another hosted model.

After success, report the code location, identity and session mapping, integration and tool, safe result summary, log ID, and useful dashboard destinations. For an explanation, migration plan, or narrow bug fix, use that task's own completion condition instead of forcing a new tool call.

## Use canonical documentation

Fetch current Markdown before giving version-sensitive commands or editing SDK integration code:

```text
https://docs.composio.dev/llms.txt
https://docs.composio.dev/docs/<page>.md
https://docs.composio.dev/toolkits/<toolkit>.md
```

Read [Errors and provider gotchas](errors.md) for failures shared across products.

## Do not

- Do not replace a dashboard-provided credential with a general setup flow.
- Do not stop at documentation when the user asked for implementation.
- Do not guess toolkit or tool slugs.
- Do not create auth configs as a universal prerequisite.
- Do not replace the application's identity model or agent architecture.
- Do not claim an integration works before the requested proof succeeds.
