# Credential-free Runner acceptance foundation

This directory defines the reviewable, deterministic foundation for Runner
acceptance checks. It contains no launcher and grants no authority to start
Paperclip, a provider process, a browser, a remote environment, or a billable
model request.

The catalog covers:

- every current built-in direct adapter except the explicitly deferred Pi
  adapter;
- the external-plugin direct-adapter compatibility contract;
- Paperclip Runner with Codex;
- Paperclip Runner with the qualified OpenCode model; and
- Paperclip Runner with the qualified ACPX Claude and Codex profiles.

The direct-adapter cells assert the legacy boundary: runnerd does not start,
native records are not created, direct finalization remains authoritative, and
classic task controls remain available. Native cells assert persisted provider
identity, runtime authority, structured-question behavior, and recovery of an
already-recorded run after the rollout flag changes.

Registered compatibility-only adapters, including the retired `acpx_local`
entry, remain in the direct catalog so a future selection check can prove they
never fall into native execution. Their presence is not a claim that the
adapter can start a provider session.

## Commands

Run the isolated unit suite:

```sh
pnpm test:runner-acceptance
```

Check the standalone TypeScript boundary:

```sh
pnpm test:runner-acceptance:typecheck
```

These commands are credential-free. They validate the catalog and pure support
utilities; they do not claim that a provider was contacted.

## Result boundary

Future fixture executors may emit `paperclip.runner-acceptance.result/v1`
objects and pass them to `buildRunnerAcceptanceReport`. Results must name a
catalog cell, report every expected assertion, carry successful redaction, and
contain no sensitive-looking structured values. The aggregator produces only
in-memory normalized data plus optional Markdown or JUnit strings. It does not
write evidence, screenshots, history, or public reports.

## Deliberate exclusions

This foundation does not include:

- Pi or any Pi transitive package;
- Claude Managed or AWS AgentCore;
- Daytona, remote images, live provider execution, or cost accounting;
- provider-key loading, secret references, auth-file discovery, or tracked env
  templates;
- screenshots, traces, raw logs, evidence archives, dashboards, history, or
  publication workflows; or
- the eval kernel, scenario explorer, browser SDK, or package/runtime
  replacement work.

Add an executor only in a later, explicitly authorized change. Keep its launch
authority separate from this catalog, and make any billable or secret-bearing
mode opt-in and independently reviewed.
