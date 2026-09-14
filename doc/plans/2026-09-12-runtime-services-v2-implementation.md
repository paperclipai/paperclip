# Runtime Services V2 implementation

Date: 2026-09-12
Updated: 2026-09-14
Status: Implementation under review. Live Daytona and hosted acceptance remain incomplete.

## Purpose

A service is a company-owned process that can outlive the agent run that created it. A stable service identity connects the process, its retained files, task provenance, preview endpoints, policy and audit history. Finishing an agent run does not stop the service or delete its data.

The requirements are in `2026-09-12-runtime-services-v2-requirements.md`. The current acceptance gaps are in `2026-09-14-runtime-services-release-checklist.md`.

## Storage and contracts

`packages/shared/src/runtime-services.ts` defines service state, launch requests, controls, policies and tool names. `packages/db/src/schema/runtime_services.ts` stores allocations, services, event receipts, preview sessions, shares, company policies, task-workspace bindings and data-deletion jobs. All operations enforce the company boundary.

Allocations own durable provider/workspace identity independently of a run. Service creation and controls use durable request keys and input hashes. An uncertain response can be retried with the same request without creating another service or applying a second mutation. Revisions reject stale edits. Process receipts and provider credentials are private server data.

The consolidated migration follows the current master schema. It tolerates replay and the earlier development migrations without deleting service state. Tests exercise both current-master installation and development-history upgrades, including intervening master migrations.

## Controller and providers

`server/src/services/runtime-services/` contains authorization, placement, policy, provisioning, lifecycle control, retention and preview access. Startup, stop, observation and retention use separate bounded work queues. A slow provider request does not block unrelated Stop actions. Controller claims fence delayed work against newer generations.

The plugin SDK defines an explicit service capability. A provider must advertise independent service allocation, process control and retention support. Older providers cannot silently substitute an ephemeral run allocation. The Daytona implementation pins connection identity before uncertain acquisition and retains the original allocation when identity or termination is unverified.

Local production launches use a bounded writable workspace, explicit environment projection and the platform sandbox. macOS uses a Seatbelt policy. Other supported local platforms require the installed Codex permission-profile launcher. Unsupported network policies are rejected.

Remote process identities include provider allocation and kernel identity. A remote PID must never be checked or signalled in the host namespace. Registration, stop and handoff verify that the process is still owned by the expected run/allocation. Mere command-start notifications do not prove a service exists.

## Run and workspace continuity

Native runners and legacy adapters receive the same first-class service tools through their supported tool transport. Native authority is bound to the task/run. Legacy MCP delivery uses a separate run-bound capability. Every call rechecks authorization, company membership and active-run ownership.

Retained services protect their provider allocation from ordinary run cleanup. A later task can attach to the retained workspace. Host mirror restoration verifies the saved receipt and refuses a different checkout at the same path. Uncertain remote ownership keeps execution held for recovery rather than authorizing a replacement.

Warm native sessions retain their original workspace and provider identity. Restart recovery validates process ownership and uses fenced provider controls. Changed configuration, credential continuity, companion bridges and the complete ordinary-heartbeat remote journey still require the acceptance listed in the release checklist.

## Credentials and data retention

Service environments use the existing secret store and binding authorization. Credentials are resolved at launch, redacted before durable logs, and omitted from read responses. Editing a service environment requires stopped state. Latest and pinned secret versions preserve their existing meanings.

Stopping compute, removing a service and deleting retained data are separate actions. Deletion commits an immutable intent and admission fence before provider/filesystem mutation. Cleanup verifies physical ownership, shared consumers and retry receipts. Nested managed-instance cleanup remains blocked until its complete resource integration is qualified.

Storage measurement is available. It is not a storage quota. Running-service and retained-allocation caps, lifecycle defaults and retention expiry have separate policy enforcement.

## Preview gateway

The gateway recognizes preview hosts before control-plane routing, parsing and logging. HTTP and WebSocket traffic use endpoint-bound access. A private sign-in exchanges a short-lived, single-use ticket for an HttpOnly preview cookie. Sessions recheck membership or share validity; existing streams and sockets also revalidate access.

Provider preview credentials stay on the upstream request. Board cookies, caller-supplied provider headers and untrusted forwarding headers do not reach the app. Unknown hosts, other-instance hosts and unsafe upstream substitutions fail closed.

Stable origins survive service restart and sleep. A document navigation can wake an idle service without invoking an agent. Background traffic does not wake or renew it. Explicit Stop requires an explicit Start. Visibility signals are separate from health checks. Restrictive app CSP can prevent visibility instrumentation; the UI exposes missing signals. Service workers are unavailable on managed preview origins. HTML instrumentation supports UTF-8 HTML up to the decoded size limit.

Hosted routing needs wildcard DNS/TLS, the browser public-suffix boundary, a trusted edge-to-instance host contract and Cloud lifecycle integration. See `2026-09-14-runtime-services-ui-review-and-hosting.md`.

## Verification

`tests/runtime-services/README.md` documents Linux process ownership, handoff and recovery acceptance. `tests/e2e/runtime-services.config.ts` covers ordinary service controls. Separate opt-in configurations cover authentication, sharing, retention, storage, deletion, controller restart and actual agent continuation.

The local agent acceptance supports CLI Codex, native Codex and Codex through ACPX. Its core story creates an app, completes the first run, edits the same files in a later run and checks Fast Refresh at the same service origin. Optional variants install dependencies from an empty workspace and revisit after the original runner expires. Live-model scenarios consume model usage and require explicitly configured test credentials.

Storybook exercises production components with simulated API responses. It is suitable for UI review, not provider or authentication acceptance. Historical local runs establish individual scenarios; they do not qualify a later rebased head. Each PR records its own verification, and the release checklist remains open until every required live scenario is complete.
