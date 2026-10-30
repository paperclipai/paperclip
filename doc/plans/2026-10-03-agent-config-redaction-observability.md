# ADR: Make agent-config redaction observable on agent reads

- Date: 2026-10-03
- Status: Accepted
- Issue: AI-574

## Context

`GET /api/agents/{id}` redacted `adapterConfig` and `runtimeConfig` for any
caller that is not the agent itself and lacks `agents:create` for the company:

```ts
function redactForRestrictedAgentView(agent) {
  return { ...agent, adapterConfig: {}, runtimeConfig: {} };
}
```

The response was a `200` with an empty object and nothing distinguishing it from
a genuinely empty config. A caller could not tell "this agent has no config"
from "you are not allowed to see this agent's config".

The failure mode is silent and self-reinforcing:

- Self-reads are never restricted (`req.actor.agentId !== id` is the only
  condition), so **every agent's own config looks healthy** while **every peer's
  looks empty**. Each agent independently concludes its peers are misconfigured.
- ~28 issues were filed on the false premise "agent X has an empty
  `adapterConfig`". `AI-565` even published a postmortem concluding configs
  were "genuinely empty", reasoning that the same route returned the CTO's full
  config verbatim — an inference invalidated by the self-read exemption.
- `GET /api/agents/{id}/configuration` *does* return a visible `403` for the
  same condition. That inconsistency is what makes the trap easy to fall into:
  the strict endpoint denies, the lax endpoint lies.

## Decision

Agent reads carry an explicit, symmetric visibility marker. Three new fields on
every agent read:

| Field | Meaning |
| --- | --- |
| `configurationAccess` | `"full"` or `"redacted"` |
| `adapterConfigKeys` | top-level key names of the real `adapterConfig`, never values |
| `runtimeConfigKeys` | top-level key names of the real `runtimeConfig`, never values |

The key-name fields are always populated, including on restricted reads. That
answers the only question a caller without `agents:create` actually has — *is
this agent configured?* — without exposing values. The marker answers the
question the old response could not: *am I looking at a redaction?*

Applied to both agent read surfaces:

- `GET /api/agents/:id` and `GET /api/agents/me`
- `GET /api/companies/:companyId/agents`

`GET /api/agents/:id/configuration` is unchanged. It already denies visibly and
returns a partial payload with value-level masking (`redactEventPayload`), which
is a different concern from response-shape redaction.

### Types

The marker is a property of an agent *read*, not of the agent entity, so it
lives on a view type rather than on `Agent`:

```ts
type AgentConfigurationAccess = "full" | "redacted";
interface AgentConfigurationView { configurationAccess; adapterConfigKeys; runtimeConfigKeys }
type AgentWithConfigurationAccess = Agent & AgentConfigurationView;
interface AgentDetail extends AgentWithConfigurationAccess { ... }
```

`Agent` is unchanged. Baking a permission-derived field into the entity would
force every producer — including `plugin-host-services.ts`, which returns raw
rows across a different trust boundary — to fabricate a value that has no
meaning there. `withConfigurationAccess` therefore constrains only the two
config fields structurally; its return type still guarantees the marker, so a
response built through it cannot drop it.

## Consequences

Good:

- The distinction between "empty" and "hidden" is now readable from the
  response. A future agent auditing peer config sees
  `configurationAccess: "redacted"` and reads `adapterConfigKeys` for signal,
  instead of inferring misconfiguration from `{}`.
- Postmortems can no longer draw the invalid self-read inference.
- No secrets leaked: only top-level key names are exposed, and a test asserts
  config values never appear in the key-name fields.
- Additive response change. No consumer breaks; fields are ignored if unknown.

Costs and limits:

- Top-level key names are visible to any authenticated agent in the company.
  `env` and `headers` are typical key names; their *values* are not exposed.
  This is the accepted trade for making "is this agent configured?" answerable.
  If that is too much, option 2 in the issue (marker only, no key names) is the
  fallback and is a one-line change.
- `buildAgentDetail` is not annotated `Promise<AgentDetail>`, so the compile-time
  guarantee is not enforced on that route today. It is unsatisfiable because
  `agentService.getChainOfCommand` and `access.getMembership` return drizzle
  rows whose enum/union columns are wider than `AgentChainOfCommandEntry` and
  `CompanyMembership`. Tracked as follow-up debt below rather than widening the
  public contract or casting around it.

## Alternatives considered

1. **Marker only, no key names.** Cheapest and leaks least, but leaves a
   restricted caller unable to answer "is this agent configured?" — half the
   original problem. Rejected.
2. **`403` on `GET /api/agents/:id` when the config is restricted.** Loudest and
   simplest, but it breaks every agent read of a peer, including the fields
   agents legitimately need (status, `reportsTo`, chain of command). Rejected:
   the aggregate is useful, only the config is not.
3. **Require `agents:suggest-changes` for peer config reads.** Couples the fix to
   a board grant that is still pending approval, and does not solve the silent
   part — a `200` with `{}` is still indistinguishable from empty. Rejected;
   noted as independent.
4. **Redact to key names with no marker** (`adapterConfig: { model: null }`).
   Conflates "redacted" with "present but null" and changes value shape. Rejected.
5. **Put `configurationAccess` on `Agent`.** Rejected for the reasons in Types
   above; it would make `plugin-host-services.ts` fabricate authorization state.

## Verification

- `server/src/__tests__/agent-config-redaction-routes.test.ts` — 5 tests:
  restricted read is marked and still reports key names; values never leak
  through the key-name fields; unrestricted read reports `"full"`; the list
  endpoint marks each entry; a genuinely empty config is distinguishable from a
  redacted one.
- `pnpm -r typecheck` clean.
- `pnpm --filter @paperclipai/server exec vitest run` — 532 passed. The 6
  failures are pre-existing and unrelated: `opencode-local-adapter-environment`
  (3) and `workspace-runtime` (2) time out under parallel load and pass in
  isolation, and `issue-attachment-routes` has an unrelated real defect
  recorded on AI-568.

## Rollback

Revert the commit. The change is additive to the response body and touches no
schema, no migration, and no stored data, so a revert is total and needs no
data repair. The only residue would be agents that started depending on
`configurationAccess`, which is safe: readers should treat an absent field as
the old behavior.

## Follow-up debt

- Narrow `agentService.getChainOfCommand` and `access.getMembership` return
  types to their domain unions, then annotate `buildAgentDetail` as
  `Promise<AgentDetail | null>` so the marker is compiler-enforced on the route.
- Bulk-close the ~28 duplicate issues asserting an empty config, now that the
  response is unambiguous.