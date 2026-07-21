# Apps, Connections, and Integrations

Audience: internal engineers and product contributors working on integrations.

Post-read action: classify a new integration request, pick the right Paperclip
layer to change, and avoid creating a parallel connection framework.

## Decision Record

Board decisions from [PAP-13211](/PAP/issues/PAP-13211) make the Apps v2
substrate on the PAP-10341 branch canonical:

- **D1: Apps v2 is the substrate.** The active model is
  `tool_applications`, `tool_connections`, catalog entries, profiles, policy
  rules, action requests, gateway sessions, audit events, and runtime slots.
  Connections v1 is retired as an implementation path.
- **D2: one vault, brokered projections.** Durable third-party credentials live
  in `company_secrets` as secret refs. Adapter config, plugin config, harness
  credential files, and run environments may receive only brokered or projected
  credentials.
- **D3: the vocabulary and three-door IA are product law.** The default product
  doors are Apps, Connections, and Review. Protocol and operator-depth concepts
  live behind Developer or Advanced surfaces.
- **D4: unification lands on PAP-10341.** Pages, CircleBack-style harness MCP
  OAuth, provider gallery work, and plugin-provided integrations converge on
  this branch instead of spawning new integration substrates.
- **D5: inbound stays thin.** External clients that call Paperclip use scoped
  Paperclip tokens and existing profiles/rules. They do not get a separate
  permission model.

## Canonical Object Model

Use **connection** as the unifying noun. A connection is four things:

1. A stored credential reference.
2. A capability catalog.
3. A governance layer.
4. An audit trail.

Everything else is an axis on that object:

| Axis | Values | It answers |
| --- | --- | --- |
| Direction | outbound, inbound | Who is the client? |
| Transport | MCP, native REST/OpenAPI, OAuth app install, webhook | How do bytes move? |
| Auth mode | OAuth, API key/PAT, app installation, none | What does the secret represent? |
| Credential owner | company, user, run | Whose identity acts? |
| Packaging | catalog entry, plugin, skill | How does it ship? |

MCP is a transport, not a product category. "Install the Discord app",
"connect Google Drive", and "add an MCP endpoint" all produce governed
connections with different transport/auth values.

## Layer Stack

When you are unsure where a change belongs, place it on the narrowest layer that
solves the problem:

| Layer | Owns | Examples |
| --- | --- | --- |
| Surface | user-facing Apps, Connections, Review, Developer/Advanced screens | gallery cards, setup wizard, review queue |
| Governance | profiles, bindings, allow/ask-first/block rules, quarantine, audit | read-only profile, ask-first write policy |
| Capability | action catalogs, schemas, risk classes, changed-tool review | `search_issues`, `create_comment`, schema hash |
| Credential | `company_secrets`, OAuth broker, credential resolver, token broker | Slack bot token ref, Google OAuth refresh token ref |
| Identity | actor attribution and token exchange | board user, agent run, first-party service identity |
| Transport | how the external system is reached | remote HTTP MCP, local stdio, REST/OpenAPI, webhook |

The agent should not hold a durable provider credential. It should hold a
Paperclip run/session token; the server or broker resolves the connection,
checks governance, invokes the provider, and writes audit.

## Identity vs. connections

Signing a user *in* and connecting a *resource* are different planes with
different owners, different token profiles, and different homes. Do not merge
them. The source of truth for this boundary is
[`paperclip-id/docs/identity-model.md`](https://github.com/paperclipai/paperclip-id/blob/master/docs/identity-model.md);
this section is the connections-side pointer so connector implementers inherit
the rule without re-deriving it.

| Plane | Question | Lives where | Token profile |
| --- | --- | --- | --- |
| **P1. Sign-in methods** | *Who are you?* | `paperclip-id` (id.paperclip.ing → Account) | Minimal-scope provider tokens (`openid email profile`), used once to authenticate, encrypted at rest, never exported |
| **P2. Connections (Apps)** | *What may your agents touch?* | Paperclip App instances (`tool_connections`), acquired via the **connect broker** for hosted + self-hosted | Rich-scope, long-lived resource tokens in the **instance's** encrypted vault; per-agent grants; ask-first on writes |
| **P3. Login with Paperclip** | *Who may authenticate against us?* | `paperclip-id` OIDC provider + DB-backed client registry ([`docs/oidc.md`](https://github.com/paperclipai/paperclip-id/blob/master/docs/oidc.md)) | Our ES256 ID/access tokens issued *by* us to registered RPs (instances, the broker, future third parties) |

Everything in `doc/connections/` — the [First-30 matrix](./FIRST-30-MATRIX.md),
the [connector playbook](./CONNECTOR-PLAYBOOK.md), and the connect-broker work —
lives on **plane P2**. It never acquires, stores, or brokers a P1 sign-in token.

### The standing rule (D7)

Adopted as a standing rule (decision D7) with the identity-model plan; the full
rationale lives in the source-of-truth doc linked above. State it verbatim in any
P2 design so the app-store work cannot drift into merging the planes:

> Sign-in tokens are never reused as resource tokens; id.paperclip.ing never
> stores resource tokens; no connections hub on the ID service.

P2 tokens flow broker → instance vault as pass-through only; the id.paperclip.ing
Account page therefore must **not** grow a "Connections" hub. The reasons to
hold the planes apart (from the plan §3):

- **Scope discipline.** Sign-in wants the narrowest grant; connections want
  deliberately broad ones. One button that does both is how you grant repo
  access just to log in.
- **Blast radius.** id.paperclip.ing holding every customer's Vercel/Slack/GitHub
  resource tokens would make it the single juiciest target in the fleet; the
  broker is intentionally pass-through.
- **Self-hosted symmetry.** Instances own their vaults, so self-hosters don't
  depend on our uptime to *use* their own connections.
- **Legibility.** Sign-in and connections answer different user questions, and
  every product we benchmarked (Vercel, Railway, GitHub, Google) keeps them on
  separate pages with separate names.

### Naming alignment

Use the surface-correct name for each plane; they intentionally differ:

| Surface | Plane | Name to use |
| --- | --- | --- |
| Paperclip App instances | P2 | **"Connections"** |
| id.paperclip.ing Account | P1 | **"Ways to sign in"** |
| id.paperclip.ing admin | P3 | **"OIDC clients"** (until the app store productizes it) |

## Packaging Rule

Default to a **catalog entry** when an integration can be described as metadata:
manifest, auth config, action catalog, resource filters, and policy defaults.

Use a **plugin** only when the integration needs product code such as custom UI
pages, its own tables, workers, migrations, routines, or specialized ingestion.
A plugin may bundle catalog entries, but it must not bypass the connection,
profile, policy, credential, and audit model.

Use a **skill** for agent instructions. Skills may use connections; they must
not own durable tokens.

## Canonical Docs

- [Glossary](./GLOSSARY.md) defines product and internal terms.
- [Identity vs. connections](#identity-vs-connections) fixes the P1/P2/P3
  boundary and the D7 standing rule; the source of truth is
  [`paperclip-id/docs/identity-model.md`](https://github.com/paperclipai/paperclip-id/blob/master/docs/identity-model.md).
- [Security threat model](./SECURITY-THREAT-MODEL.md) harvests the keeper from
  [PAP-2359](/PAP/issues/PAP-2359) and maps it onto Apps v2.
- [First-30 matrix](./FIRST-30-MATRIX.md) harvests the keeper from
  [PAP-2432](/PAP/issues/PAP-2432) and is the source matrix for connector
  playbook work.
- [Connector playbook](./CONNECTOR-PLAYBOOK.md) is the repeatable template for
  adding a vendor as a catalog entry on Apps v2.
- [MCP access governance](../MCP-ACCESS-GOVERNANCE.md) remains the operator
  runbook for the current gateway, profile, policy, approval, runtime, and audit
  APIs.

## Migration Notes

Connections v1 contributed useful policy, UX, and rollout thinking, but its
implementation branch is no longer the target. When you see old tickets or code
using `connections`, `connection_grants`, or a provider-directory mental model,
translate the intent into Apps v2:

| Connections v1 intent | Apps v2 home |
| --- | --- |
| Provider directory | Apps gallery / `tool_applications` |
| Configured provider instance | Connection / `tool_connections` |
| Grant allowlist | Profiles, profile bindings, policies |
| Resource filters | Policy/profile conditions plus provider config |
| Tool broker | Tool gateway and runtime supervisor |
| Connection UX tail | Apps, Connections, Review, Developer/Advanced IA |

Do not add new work to the retired v1 branch. If an old ticket still describes a
valid product gap, retarget it to an active Apps v2 issue or close it as
superseded with a link to the replacement.
