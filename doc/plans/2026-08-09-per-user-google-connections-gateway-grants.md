# Per-User Google (Gmail/Calendar) and Slack Connections — Gateway Grant Resolution

Date: 2026-08-09
Status: accepted, implementation starting
Owner: Dan Costanza
Tickets: TECH-4994 (implementation), TECH-4992 (public-agent refusal, folded in), TECH-4993 (personal-only health model, related)

## Scope note: Slack rides the same mechanism

Dan confirmed the same requirement applies to Slack: agents must act as the
specific person, never a shared/workspace Slack identity. The gateway
grant-resolution mechanism below is provider-agnostic and covers Slack too,
but Slack needs one additional fix Google doesn't: the current `slack.json`
connector (`packages/shared/src/app-definitions/slack.json`) requests
`channels:read` / `chat:write` / `search:read` — these are Slack **bot-token**
scope names, not user-token scopes. Slack's OAuth v2 flow issues two separate
tokens in one exchange: `scope` → bot token (shared workspace identity),
`user_scope` → a token acting as the specific authorizing person. As
configured today this connector would produce a bot token — the exact shared
identity this plan rules out. Fix: reconfigure the Slack connection to request
`user_scope`-based scopes (Slack's equivalent user-token names, e.g.
`channels:read`/`chat:write`/`search:read` under the user-token namespace) so
the resulting grant is per-person, then mark it `personal_only` and resolve it
through the same gateway path as Google. Verify the actual token type
returned before assuming this is done — do not assume from the connector's
current shape.

## Decision

Personal Google access (Gmail, Calendar) for Paperclip agents is delivered as:

1. **Backend: rh-google-mcp** (`https://rh-google-mcp.drum-mackarel.ts.net/mcp`),
   RH's existing Okta-gated Google Workspace MCP service — NOT Google's hosted
   MCP servers, and NOT a new Paperclip-owned Google connector.
2. **Identity: per-user connection grants, resolved at the gateway.** One
   company-level connection; each user authorizes once, personally; every
   agent run presents the grant of the run's `responsibleUserId`. No
   workspace/shared credential exists for this connection class.
3. **Public/shared agents are refused outright** at the same code path
   (TECH-4992). Gmail and Calendar have no non-personal identity; an agent
   multiple people can drive has no valid subject.

## Why rh-google-mcp over Google's hosted MCP

Verified live 2026-08-09:

| | rh-google-mcp | Google hosted MCP (`gmailmcp`/`calendarmcp.googleapis.com`) |
| --- | --- | --- |
| Auth discovery | Standard: 401 + `WWW-Authenticate` at `initialize` | Nonstandard: `initialize`/`tools/list` succeed anonymously; 401 only at `tools/call` (breaks Paperclip's OAuth discovery — connection appears healthy/no-auth) |
| Client registration | DCR (`registration_endpoint` live) — zero client management | Manual GCP OAuth client + redirect URI + env vars + redeploy per instance |
| Gmail send | Yes (`gmail.send`), governed by Paperclip ask-first | No — draft-only |
| Tool breadth | Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Contacts, Tasks, directory | Gmail (13 draft/read/label tools), Calendar (8 tools) |
| Org lock | Okta, `@redesignhealth.com` only; per-user Google tokens server-side | Whatever the GCP client's consent screen allows |
| Maturity | In production at RH for months | Developer Preview |

Google-direct remains a drop-in swap later: the gateway patch is
backend-agnostic (it resolves a grant and attaches it; the server URL is
connection config).

## The gap being closed

Paperclip has the full per-user data model and API — `connection_grants` with
workspace/user subject rules, self-only `start-authorization`
(`server/src/routes/tool-access.ts:178,290`), fail-closed
`mintConnectionTokenForAgent` keyed to `responsibleUserId`
(`server/src/services/tool-access.ts:7214`), and the "Connect your account"
issue-thread interaction card (`tool-access.ts` inside `startOAuth`, ~5480).

But the gateway execution path ignores all of it:
`executeRemoteHttpTool` (`server/src/services/tool-gateway.ts`, ~3004) attaches
`resolveCredentialHeaders(connection)` — connection-level credential refs only.
No per-user resolution, no prompt on missing grant, no `isPublic` check.

Upstream state (checked 2026-08-09): the v3 schema core landed
(paperclipai/paperclip#9958, merged 2026-07-21) and explicitly names
"per-user authorization, token brokering" as later phases; those phases have
not shipped on master. Nothing to cherry-pick. Prior art in flight: #5584
(OAuth backbone, stalled) — mine for design only. Ecosystem survey found no
multi-user personal Google anywhere: existing patterns are one-named-person
connections (#10135), robot accounts (google-sheets), single refresh token in
plugin config (#4584), or a dedicated IMAP mailbox (QSL plugin-email).

## Implementation

Topic branch off master per the fork's patch-series discipline
(`doc/plans` in redesignhealth/paperclip; see TECH-4921 repo structure).
Upstream-PR-shaped: this is the next phase of upstream's own v3 roadmap.

In `server/src/services/tool-gateway.ts` (and shared helpers in
`tool-access.ts`):

1. **Connection classification.** New `identityModel` field
   (`"personal_only" | "company_or_personal"`) on
   `AppDefinition`/`ConnectionMethodDef` and connection config; default
   existing behavior (`company_or_personal`). rh-google-mcp connection is
   marked `personal_only`.
2. **Per-user resolution at execution.** For `personal_only` connections,
   `executeRemoteHttpTool` resolves the session/run's `responsibleUserId` →
   `connection_grants` row (`kind = "user"`, `subjectUserId = responsibleUserId`),
   refreshes if needed, attaches that grant's bearer token. Never falls back
   to connection-level credentials or a workspace grant.
3. **Prompt on missing grant.** On no grant: create the existing
   "Connect your account" `issueThreadInteractions` card (reuse the block in
   `startOAuth`) targeted at the responsible user, and return a structured,
   non-retryable-without-action error to the agent (mirror
   `user_authorization_required` + `remediation: start_authorization`).
4. **Public-agent refusal (TECH-4992).** If the calling agent has
   `isPublic = true` and the connection is `personal_only`: fail closed
   (403, `agent_not_personal`) before any grant lookup.
5. **Health model (TECH-4993, minimal slice).** For `personal_only`
   connections, health = transport reachability; do not surface the
   "reconnect a default credential" banner.

## Rollout / validation

1. Build + tests + review; new image tag; deploy to paperclip-dev
   (`rh-paperclip` terraform, cluster `rh-platform-dev-cluster`, service
   `paperclip-dev`, currently image `v2026.722.0-rh.3`, task def rev 8).
2. Connect rh-google-mcp via "Connect with a link"; archive the
   `calendarmcp.googleapis.com` connection from 2026-08-09.
3. Single-user proof: Dan's agent reads Dan's calendar after one
   connect-card OAuth.
4. Multi-user proof: a second person's agent prompts *them* and acts as them.
5. Governance pass: calendar + Gmail read/draft enabled; `send` and event
   mutation behind ask-first.

## Cleanup from the 2026-08-09 Google-direct detour

Superseded by the rh-google-mcp path (remove after validation):

- GCP web OAuth client `81433489654-h4akib90…` in project `dsc-hermes`
  (redirect `https://paperclip-dev.drum-mackarel.ts.net/api/tools/oauth/callback`).
- SSM `/paperclip/dev/PAPERCLIP_TOOL_OAUTH_{CALENDARMCP,GMAILMCP}_GOOGLEAPIS_COM_CLIENT_{ID,SECRET}`
  and the matching `secret_ssm_paths` block in
  `rh-paperclip/terraform/environments/dev/main.tf` (applied, task def rev 8).
- Stale `/paperclip/prod/GOOGLE_{CLIENT_ID,CLIENT_SECRET,REFRESH_TOKEN}` SSM
  params (never wired to anything).
- `~/Downloads/client_secret_81433489654-*.json` (plaintext secret on disk).
