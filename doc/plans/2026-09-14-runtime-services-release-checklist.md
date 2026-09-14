# Runtime services release checklist

Date: 2026-09-14

This reconciles the current implementation with the agreed A–N requirements. It supersedes earlier chronological “remaining work” notes where later evidence resolved a gap. It does not waive any requirements or declare the feature release-ready.

## Acceptance status

| Scenario | Established evidence | Still needed |
| --- | --- | --- |
| A. Storybook survives the agent | Actual local native agent creates/installs Storybook; a second run edits it at the same service origin | Live Daytona and hosted origin |
| B. Vite creation and iteration | Actual local CLI, native and ACPX runs; native installs dependencies from an empty workspace; later edit preserves counter state through Fast Refresh | Same complete workflow on live Daytona |
| C. Ten-minute revisit | Actual local native five-minute runner expiry and 610-second service continuity | Live Daytona/provider retention and hosted revisit |
| D. Automatic sleep and explicit stop | Local gateway/browser sleep/wake and stable origin; explicit Stop remains distinct | Deployed gateway, Cloud-stack sleep interaction, live provider |
| E. Shared sandbox | Service/allocation consumer guards and provider-contract integration | Full live frontend + API + agent journey |
| F. Controller restart | Local graceful/forced browser restart; remote retained-runner recovery with actual runner subprocess and fixture provider; recovered executor accepts another turn | Ordinary heartbeat dispatch/acquisition/workspace sync + recovered runner + managed Vite preview in one remote journey; changed configuration/credentials and companion bridge |
| G. Agent tools/events | First-class tools delivered to native and CLI/ACPX; explicit management receipts and authorization | Complete supported event-convergence qualification; command-start events alone cannot authorize adopting a process |
| H. Existing process registration | Actual local two-run registration/Vite stories; Linux and remote ownership/registration fixtures | Live Daytona; remaining uncertain-launch/per-run cleanup and compatibility cases |
| I. Reliable controls | Local browser coverage for mobile properties, slow/failed startup, draft preservation, uncertain mutations and conflicts; dedicated Storybook review | Remaining simultaneous agent/operator races and hosted equivalents; human UI approval |
| J. Activity/company policy | Real local visibility, hidden tabs, deadline/cap and company-policy browser cases | Provider enforcement and Cloud lifecycle acceptance |
| K. Bounded crash recovery | Local browser restart/crash budget and durable lifecycle tests | Live Daytona recovery/retry behavior |
| L. Private/shared preview isolation | Local authenticated HTTP/WebSocket and browser isolation, revoked shares, restricted local process tests | Public wildcard/TLS/suffix boundary and deployed Cloud routing/access tests |
| M. Exposure/provider loss | Distinct process/exposure/retention states; fixture outage/recovery and checkpoint proofs | Actual provider token expiry/refresh, sandbox loss, deployed recovery |
| N. Task completion preserves services | Retained-allocation/workspace cleanup guards; task attachment/detachment and owned-data deletion tests | Live task cleanup on Daytona and managed nested-instance deletion integration |

The implementation overview and test entry points are in `2026-09-12-runtime-services-v2-implementation.md`. The evidence column summarizes historical local acceptance; each PR must verify its own head. Historical test counts are not added together.

## Concrete implementation gaps

- Service launch does not yet preserve network allowlists: it explicitly refuses those allocations (`server/src/services/runtime-services/placement.ts`).
- Storage measurement, retention expiry and allocation/running-service caps exist. Storage-use limits remain outstanding; measurements are not quotas.
- Managed nested-instance cleanup primitives exist, but ordinary workspace data deletion still blocks these workspaces pending the full resource-aware integration.
- Standalone/task checkout continuity still needs its remaining real acquisition/heartbeat acceptance and compatibility cases.
- Warm recovery across changed harness configuration/credentials, managed GitHub companion continuity, and uncertain process cleanup remain outstanding.
- Cloud preview ingress needs the repository changes and infrastructure listed in `2026-09-14-runtime-services-ui-review-and-hosting.md`.

## Handoff boundary

The local UI review is independent of provider acceptance. Storybook uses simulated data and cannot qualify sandbox lifetime, real authentication, storage deletion, hot reload, or service ownership. No live Daytona test connection was used in this pass. No production deployment or Cloud/DNS change was performed.

The initial local snapshot passed workspace typecheck and build, 6,047 UI tests in 587 files, token gates and Storybook rendering. Full repository tests were still in progress at that review. These are historical results; they do not establish verification of later integration or review commits. Consult each PR for its current-head checks.


## Local process handoff limit

Local registration rechecks a captured member's birth identity and process group synchronously immediately before each termination signal. It fails closed when no captured member still anchors the group. POSIX group signals still use a numeric PGID, so kernel scheduling can leave a residual process-group reuse race between the final observation and signal. This is a platform limit, not an atomic identity-bound termination guarantee. Live acceptance must retain that distinction.
