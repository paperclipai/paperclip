# Experimental chat channel landing plan

The chat integration lands in two dependent changes after the native runner
prerequisites in #13092. The runner change is not one of these two chat changes.

## First change: provider and data foundation

Add the closed channel types, additive database schema, pinned provider adapter
patches, packaged dependencies, and opt-in runtime and transport helpers. Include
their real-parser, synthetic-transport, migration, and package qualification tests.
Keep the existing server routes, application catalog, experimental settings,
heartbeat dispatch, and Board entry points unchanged. This change does not start
provider connections or expose partially implemented channel routes. The existing
production GitHub tool connection keeps its current path.

Validate this change against the existing master consumers independently. Run
repository types, tests, and build, the historical database upgrade checks, and
the release patch-packaging checks. Exact-head CI and code review are required.

## Second change: gated service and Board integration

Add company-scoped durable admission, identity and reach authorization, leases,
queues, publications, native controls, and the Board user journey. This includes
the provider-specific registration and service wiring for Slack, Discord,
Telegram, Teams, and GitHub. Keep activation behind the experimental channel
setting. A capability is not permission to bypass current source or user checks.

Run joined service and recovery tests, all repository checks, and the deterministic
browser suite on the composed head. Live provider observations supplement these
checks; mocked transport and browser fixtures are not live-provider proof.

Merge the foundation first. Then update the integration onto current master and
repeat exact-head verification and review. Each chat pull request must remain
under 500 changed files. Preserve uncertain delivery outcomes and explicit
unsupported cases rather than claiming complete provider qualification.
