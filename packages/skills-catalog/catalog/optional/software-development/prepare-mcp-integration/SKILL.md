---
name: prepare-mcp-integration
description: >
  Prepare MCP/vendor integrations through cited research, a content PR,
  exact-revision human approval, and one governed Paperclip connector PR per
  approved connection. Use for new integration research and delivery; not for
  ad hoc connector coding that bypasses the playbooks.
key: paperclipai/optional/software-development/prepare-mcp-integration
recommendedForRoles:
  - engineer
  - product-manager
  - researcher
tags:
  - mcp
  - integrations
  - connectors
  - research
  - github
  - human-approval
requires:
  - git
  - gh
  - curl
---

# Prepare MCP Integration

Take an input link or vendor brief through two separate phases: a reviewable
research PR in `paperclip-content`, then connector implementation in Paperclip
App only after a human accepts the exact research revision and connection set.

## Preserve These Boundaries

- Treat `paperclip-content/integrations/README.md` as the research contract and
  `paperclip-content/integrations/skills/integration-harness/SKILL.md` as its
  entrypoint. Reference and run them; do not copy their schemas, templates,
  state machines, reconciliation rules, or internal gates into this skill.
- Treat `paperclip/doc/connections/CONNECTOR-PLAYBOOK.md` on the implementation
  target branch as the connector contract. Follow it end to end; do not
  substitute remembered behavior or the examples in this skill.
- Finish Phase A with a research-only PR. Do not create an App implementation
  branch, task, or code change before the research gate is accepted.
- Bind acceptance to one research PR head SHA and an explicit connection set.
  Acceptance does not cover later commits or additional connections.
- Create one Paperclip App PR per approved connection. Shared prerequisite
  infrastructure or broad playbook corrections may use separate prerequisite
  PRs; never combine distinct connections into one connector PR.
- Keep vendor credentials in approved secret storage. Never put secrets in
  briefs, catalog files, issue text, plans, fixtures, screenshots, logs, branch
  names, commits, or PRs.

## Default Connection Experience

- Request the broadest vendor permissions and scopes the connection can
  support by default. Operators should not have to predict every future tool
  they may need during setup. Enforce safe use after connection through
  Paperclip's action catalog, resource boundaries, ask-first policies,
  quarantine, and audit controls.
- Keep the default wizard limited to the minimum information needed to create
  a working connection: connection identity, authentication, and any
  unavoidable tenant or resource boundary. Put optional scope reduction,
  feature groups, individual tool filters, response modes, transport tuning,
  and other expert controls behind one collapsed **Advanced** disclosure.
- Give advanced controls working broad defaults so an operator can finish
  setup without opening them. When a provider truly requires an explicit
  advanced choice, document the exception and explain it in plain language
  instead of exposing protocol details by default.
- Treat vendor permission breadth and Paperclip execution governance as
  separate layers. Do not reduce requested vendor permissions merely to stand
  in for missing action review, approval, quarantine, or audit policy.

## Preflight

1. Load the current Paperclip skill for checkout, comments, interactions,
   durable state, and final disposition. Load the standard PR-preparation skill
   (`prepare-paperclip-pr` for Paperclip agents) before opening any PR.
2. Resolve the input URL(s), vendor/platform, intended MCP endpoint or API,
   target repositories and branches, and the Paperclip issue that owns the
   work. Ask only when these cannot be determined safely from the brief.
3. Fetch both repositories and record the target commit hashes. Read the
   canonical files from those target commits, not from a possibly stale working
   tree. Refresh and reread them again immediately before Phase B.
4. Inventory existing integration catalog entities, open PRs, branches, and
   current AppDefinitions/connectors before creating anything. Match by
   meaning, not title or slug.
5. Determine whether the input describes one connection or several. A
   connection has one coherent credential owner, endpoint/transport, resource
   boundary, and independently reviewable action catalog. Record the proposed
   split early and refine it as evidence arrives.
6. Prefer official vendor documentation, protocol/RFC sources, safe live
   probes, and current Paperclip code. Use third-party sources only to find or
   qualify primary evidence. Record every factual claim with URL and access
   date; mark unresolved facts explicitly instead of guessing.

Do not mutate a vendor account, register a client, grant consent, or invoke a
write tool merely to research it. A safe unauthenticated metadata probe is
allowed when it does not change vendor state. Route credential- or
browser-dependent validation through an explicit QA task when it becomes
necessary.

## Keep The Run Resumable

Maintain one concise checkpoint in the Paperclip issue or an issue document:

- current phase and owning next action;
- input links and target repository commits;
- research PR URL and exact head SHA;
- proposed and accepted connection sets;
- research-gate interaction and accepted target revision;
- one branch, PR URL/head, and verification summary per connection;
- prerequisite/playbook PRs and remaining blockers.

On every restart, reconcile this state with files, branches, PRs, reviews, and
interactions before creating anything. Reuse semantic matches. Never duplicate
catalog entities, regress terminal pipeline phases, reuse stale acceptance, or
open a second PR for the same connection accidentally.

## Phase A: Research In paperclip-content

1. Create an isolated worktree and branch from the refreshed content target.
   Preserve unrelated local changes.
2. Intake the supplied links or brief through the integration harness. Let the
   harness load its sibling skills for discovery, feature research, proposal
   reconciliation, user stories, UI planning, implementation planning,
   examples, and docs briefing. Obey every internal human gate in
   `integrations/README.md`; the final research gate below does not replace
   them.
3. Build the complete reviewable OKF/planning package required by the current
   pipeline. For MCP work, make the evidence sufficient to decide:
   - official endpoint and transport;
   - auth mode, credential ownership, scopes, discovery and DCR behavior;
   - endpoint-precedence and redirect-origin constraints;
   - token lifetime, rotation, refresh, revocation, and re-auth behavior;
   - tool inventory, action risk, resource filters, account/tier/pricing
     constraints, administrator setup, and validation needs;
   - exact service involvement and system boundaries in Paperclip.
4. Ground every Paperclip-surface claim in the maintained surface map and
   current App code. Reconcile before creating, update required indexes/logs,
   and preserve lineage, timestamps, immutable slugs, and absorbing phases as
   required by the research contract.
5. Open one research-only PR to `paperclip-content`. Include the full planning
   package and any tightly coupled content-playbook correction, but no
   Paperclip App implementation.
6. Run focused validation and the required PR workflow. Do not present the gate
   until checks are green, Greptile is 5/5, all actionable review comments are
   resolved, and the recorded PR head still matches the reviewed head.

## Gate Research Before Building

1. Create or update a dedicated issue document that names:
   - the research PR URL and exact head SHA;
   - the content and App source commits used for research;
   - the proposed connection set and why each item is independent;
   - known limitations, prerequisites, and deferred questions.
2. Create a Paperclip `request_confirmation` interaction targeted at that issue
   document's latest revision. Use a revision-specific idempotency key and a
   `wake_assignee` continuation policy so either acceptance or rejection wakes
   the assignee. Ask the reviewer to include revision notes when rejecting.
3. Put the issue in `in_review` and stop. Do not prepare App worktrees or code
   while the interaction is pending.
4. On rejection, use the interaction response and any revision notes to revise
   Phase A only and present a new revision. If the research PR head, gate
   document, or connection set changes, withdraw/supersede the old confirmation
   and request a fresh one.
5. On acceptance, verify that the response still targets the latest gate
   revision and recorded PR head. Implement only the accepted connections.

## Phase B: Implement In Paperclip App

Refresh the App target branch, reread the current Connector Playbook, and record
its commit before writing code. For each accepted connection:

1. Create one isolated worktree, branch, and PR. Reconcile against current
   AppDefinitions and connector code first.
2. Follow the Connector Playbook's current decisions for catalog entry versus
   plugin, reuse path, AppDefinition, transport, credential refs, resource
   filters, action catalog, governance, wizard behavior, health/catalog,
   availability, revocation, audit, and validation.
3. Derive OAuth behavior from evidence. In particular, do not ship a complete
   authorization/token endpoint pair for a discovery-capable MCP vendor unless
   it is intentionally authoritative: current broker precedence can make that
   pair bypass stored endpoints, challenge hints, and RFC discovery. Probe DCR
   and redirect constraints safely, reuse registered clients, and cover token
   rotation/terminal refresh failures when the vendor requires them.
4. Add the connection documentation mandated by the current playbook,
   including the service-involvement statement, a sequence diagram with exact
   auth/discovery/registration/callback endpoints, and step-by-step
   administrator setup.
5. Add focused automated tests and the production-like validation hook for
   connect, catalog discovery, an allowed read, an ask-first write, a
   denied/quarantined action, revoke, and audit. Include negative company,
   actor, resource, and changed-schema cases where applicable.
6. Use a first-class QA child issue only when real credentials, vendor consent,
   or browser evidence cannot be completed safely by the implementing agent.
   Link it as a blocker and give QA exact, secret-safe steps and expected
   evidence.
7. Run the standard PR-preparation workflow for this connector PR. Do not hand
   it back for merge until focused verification passes, all required checks are
   green, Greptile is 5/5, and every actionable comment is resolved.

Complete and report each connection independently. Failure or review delay on
one connection must not cause another connection to be bundled into its PR.

## Feed New Rules Upstream

At both phases, compare new evidence with the two canonical playbooks.

- Record vendor-specific facts in that vendor's catalog artifacts, manifest,
  docs, and tests.
- When evidence changes a reusable schema, gate, template, auth rule, risk
  policy, documentation standard, or validation rule, update the owning
  upstream playbook/skill/template and add regression coverage where possible.
- Include a narrow, tightly coupled correction in the relevant research or
  connector PR. Use a separate prerequisite PR when the correction affects
  several connectors, changes shared infrastructure, or would obscure the
  one-connection review.
- Rebase/reconcile dependent work and rerun affected planning and verification
  after the correction. If the accepted research PR or connection set changes,
  repeat the research gate.
- Never knowingly leave implementation, tests, and the owning playbook
  inconsistent.

## Finish

Before marking the issue done, report the exact research PR and head, accepted
gate revision, every connector/prerequisite PR and head, focused verification,
CI/review state, and any upstream playbook changes. Leave the issue `in_review`
only for a real pending interaction/reviewer/monitor path, `blocked` only for a
named owner and concrete unblock action, and `done` only when every approved
connection has a merge-ready PR and no required follow-up remains on the issue.
