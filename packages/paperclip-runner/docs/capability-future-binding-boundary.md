# Capability Future Binding Boundary (future upload integration / ACPX)

Capability is a package-local model. It does not integrate the runner into
Paperclip, and it must not. This page states exactly what Capability defers to
future upload integration and what clean seam it preserves so the deferral stays cheap.

## What Capability does not do

Nothing in Capability contacts a real Paperclip control plane, database, ACPX
session, or provider credential. The 106-case conformance suite and the browser
explorer run entirely against the in-process
[mock ControlPlanePort](capability-mock-control-plane-port.md) and checked-in
fixtures. The [forbidden-imports boundary](architecture.md) rejects any import
that crosses into `server/`, `ui/`, `cli/`, `@paperclipai/db`, or other
Paperclip workspace internals.

## The preserved seam

The dependency arrow always points from an implementation toward a contract.
The package owns two contracts a future consumer implements:

- **`ControlPlanePort`** — the narrow surface through which a runner opens a
  run, appends ordered events, records semantic operations, and submits a
  terminal result. Capability injects the *mock* adapter behind this port; future upload integration
  injects a real one. The catalog, authorization engine, and conformance suite
  bind to the port, not to any adapter.
- **`NativeSessionBackend`** — the normalized session surface for a future
  control-plane consumer.

Because the port is the only coupling point, future upload integration replaces the adapter
without touching the tool catalog, the authorization rules, or the eval-derived
conformance suite. The package remains independently buildable, testable, and
runnable against the mock adapter after the real one exists.

## What future upload integration (ACPX) will bind

future upload integration binds a real Paperclip `ControlPlanePort` implementation behind the same
seam so the semantic tools and authorization engine act against a live control
plane instead of the mock. That work is out of scope here and requires separate
CTO approval at the Capability checkpoint (`TASK-16908`). Until then:

- ACPX is future upload integration, not Capability.
- No Capability documentation claims future upload integration capability.
- Real integration is a separately reviewed phase, consistent with the
  [future integration rule](architecture.md) recorded for every prior phase.

## Related

- [Architecture and dependency boundary](architecture.md)
- [Mock ControlPlanePort](capability-mock-control-plane-port.md)
- [Capability disposition](capability-disposition.md)
