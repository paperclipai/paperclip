# Runtime Services V2 — Requirements

Date: 2026-09-12

Status: Requirements for review; product decisions incorporated

Audience: Product, engineering, design, and runner/provider integration authors


This document describes intended V2 behavior. It is not a claim that these capabilities already exist or an implementation plan. It extends the current runtime model without replacing the existing V1 specification.

## Goal

Let agents and users create, develop, inspect, and operate persistent services through Paperclip across local hosts and sandbox providers.

“Run this app and give me a preview” should produce a usable service that survives the agent finishing. Users should not need to understand process supervision, sandbox lifetimes, port forwarding, or provider-specific commands.

The originating Storybook workflow exposed three separate requirements: the process must survive, the network endpoint must be reachable, and the returned URL must work for the user. Success requires all three.

## Agreed defaults and delivery priorities

| Topic | Decision |
| --- | --- |
| Service ownership | Company-scoped, independent of tasks, runs, and workspaces; optional associations preserve context. |
| Initial execution support | Local and Daytona-backed execution through one service model. |
| Delivery priority | Hosted Paperclip first; each instance manages its services and URL mappings. Self-hosted exposure should reuse the design without blocking hosted delivery. |
| Hosted preview domains | An isolated first-party preview namespace, routed to each owning instance. Customer-owned domains are a later addition. |
| Preview continuity | A stable application URL wakes an automatically sleeping service. A durable detail page alone is insufficient for the hosted experience. |
| Dev preview lifetime | Sleep after 60 minutes without tracked use; configurable by company and service. |
| Worker lifetime | Run until explicitly stopped, subject to configured resource and lifetime limits. |
| Human activity | A visible preview renews activity. Hidden tabs, background polling, and health checks do not keep a service alive indefinitely. |
| Data retention | Keep files and persistent application data until explicit deletion by default; administrators may configure retention. |
| Existing-process registration | Relaunch under durable supervision is acceptable; adoption without restart is not an initial release requirement. |
| Preview access | Private by default, with optional explicit expiring share links. |
| Agent authority | Manage services associated with the agent's authorized task context; broader service access requires an explicit grant. |
| Unexpected process exit | Up to three automatic restart attempts with backoff, then a visible failure with logs. |

## 1. Independent service resources

- Every service belongs to a company and exists independently of individual agent runs, tasks, and workspaces.
- Services can optionally reference their originating task, run, agent, workspace, checkout, or artifact. These associations provide provenance and discovery rather than determining service lifetime.
- Support web servers, Storybook, APIs, workers, and other long-running processes. A service does not have to expose a URL.
- Multiple services can share an execution environment.
- A service can remain running after its originating task completes. Task completion must not implicitly stop it or discard its retained data.
- A running service alone does not keep a task in progress or replace the task's own completion and liveness rules.
- Existing workspace runtime services continue working during the V2 rollout. Migration to V2 must not be required to preserve existing behavior.

## 2. Execution context and development continuity

- By default, a service starts against the agent's current files in its current execution environment, including uncommitted changes.
- Starting a dev server must not silently copy the project into another sandbox or serve a different checkout.
- Agents can explicitly select a different authorized execution environment.
- Subsequent authorized agent runs can reconnect to the service's source files and continue development.
- File changes reach the running dev server and its hot-reload mechanism without a separate deployment step.
- Record enough launch information to restart the service without another model run: command or provider launch reference, working context, environment/secret references, endpoints, and readiness expectations.
- Required source files and persistent data must remain available even if the originating task or workspace becomes eligible for cleanup. Cleanup must respect service dependencies and retention policy.
- Development previews and background workers have an explicit service purpose or policy selection so their different lifetime defaults are understandable.

## 3. Agent tools and adapter integration

- Provide first-class runner tools to start, register, inspect, list, stop, restart, and retrieve service logs and endpoints.
- Agents can notify Paperclip about services even when their adapter provides no native service events. The initial release must not depend on native event availability.
- Investigate structured command or service events exposed by supported Codex, ACPX, or other adapters, and integrate verified capabilities where available.
- Treat command execution, service discovery, and durable service management as distinct facts. A command-start event alone does not establish a managed service.
- Native events and explicit tools converge on the same service records and lifecycle.
- Duplicate, replayed, or out-of-order notifications must not create duplicate services, repeat lifecycle actions, or overwrite newer authoritative state.
- Adapter events do not grant additional permissions or automatically make arbitrary background commands persistent.
- Tool responses clearly distinguish accepted requests, pending operations, ready services, and failures, and return the service identity and available access paths.
- Tool descriptions and runtime instructions make the managed service path discoverable. Users should not need a special phrase to obtain a persistent preview.

## 4. Durable supervision and shared environments

- Managed services survive the end of an agent turn or run and the expiry of an agent's warm session.
- Ordinary shell processes retain their existing cleanup behavior; persistence is an explicit managed-service operation.
- Starting a service launches it under supervision independent of runner teardown.
- Registering an existing process must establish durable supervision. Recording a PID and URL alone is insufficient.
- Managed relaunch is acceptable when safe adoption is unsupported. Report the restart and avoid leaving a duplicate unmanaged process behind.
- Ending a run releases that run's claim on the execution environment without stopping services or other agents that still require it.
- A service's stop policy controls its need for running compute. Merely retaining a stopped service record must not keep a sandbox running forever.
- Stopping one service must not interrupt another service or active agent sharing the environment.
- Provider auto-stop and deletion settings must be reconciled with Paperclip's effective service and retention policies; a provider default must not silently defeat them.
- After Paperclip restarts, surviving services become manageable again without duplicate launches or loss of their lifecycle policy.
- Detect stale records, orphaned processes, and abandoned allocations and reconcile them safely without acting on unrelated processes.

## 5. Local and sandbox providers

- Initially support local execution and Daytona-backed execution through one service-control model.
- Local services run under supervision that survives agent-run cleanup.
- Sandbox services acquire or attach to an authorized allocation, retain it while needed, and obtain preview endpoints through the provider.
- Providers declare supported capabilities, including exposure, log streaming, restart, suspend/resume, and URL renewal.
- Unsupported capabilities produce explicit limitations rather than misleading success. Do not change execution location or access policy silently to manufacture support.
- Additional providers can implement the same service contract without redesigning the agent tools or service UI.
- Each Paperclip instance remains responsible for its service identities, policy, desired state, and URL mappings. Hosted routing infrastructure may assist without becoming a separate service ownership model.
- An instance can serve preview traffic through its existing backend using separate application hostnames. A shared preview namespace under a Paperclip-owned domain is acceptable when it satisfies the browser-isolation requirements; neither a new registered domain nor a separate preview-hosting service is required by this design.
- For example, `foo.paperclip.app` can own previews at `<instance-and-endpoint-id>.preview.paperclip.app`, with hosting ingress routing those requests to foo's backend. This proposed namespace needs wildcard DNS/TLS and the browser cookie boundary in section 9 before use. The exact namespace remains configurable; each instance owns its service mappings and preview access policy.
- Preserve straightforward local and tailnet exposure. More elaborate self-hosted stable-domain setup must not block the hosted release.

## 6. Exposure and usable URLs

- Every service has a durable Paperclip detail link, including when stopped or lacking an exposed endpoint.
- Hosted application previews also have stable URLs that survive process restarts, provider endpoint rotation, and automatic sleep. An old preview tab must not require the user to find a replacement URL.
- Opening or reloading the stable URL of an automatically sleeping service starts it, shows startup feedback, waits for readiness, and serves the requested app path and query parameters.
- Preserve the application's origin through ordinary sleep/wake cycles so app cookies, browser storage, and deep links are not needlessly invalidated.
- Services can expose multiple endpoints with their protocol, access requirements, expiration where applicable, and verification status.
- Local execution supports dynamic plain-HTTP tailnet ports without requiring per-port HTTPS registration. HTTP and HTTPS exposure can coexist when configured.
- Daytona services obtain appropriate provider preview endpoints and refresh expiring access when supported. Provider URLs and credentials are distinct from stable user-facing application URLs.
- User-facing URLs contain a real reachable hostname. Do not present `localhost`, `0.0.0.0`, or placeholder hosts as remotely usable links.
- Distinguish internal service health from verification through the intended user access path. Report when a particular reachability check could not be performed.
- Support WebSockets and hot reload where required, including frontend/API combinations and framework-specific host/origin settings.
- Failure to acquire or renew exposure must appear as an exposure failure rather than a successful usable preview.

## 7. Lifecycle, activity, and retained data

- Dev previews default to automatic sleep after 60 minutes without tracked use. Background workers default to running until explicitly stopped.
- Support company and per-service lifecycle configuration, including idle shutdown, maximum running duration, and an explicit “keep running until” override within authorized limits.
- Company idle defaults apply to newly created services; changing a default does not overwrite existing per-service choices. Company maximum running time remains a live ceiling on every service, including saved holds and active previews. Show both the requested lifetime and its effective company ceiling.
- A visible preview renews activity while the user reads or tests it. Hidden tabs, background polling, and health checks do not prevent idle shutdown indefinitely.
- Authorized agent use can renew activity. Simply leaving an idle runner session or monitoring connection open must not defeat shutdown policy.
- Activity reporting must work for supported arbitrary preview apps without requiring app authors to implement a Paperclip SDK. A blind spot must not be presented as reliable activity detection.
- When visibility signals stop arriving, the idle policy eventually applies; stale browser sessions must not retain compute forever.
- Show the effective lifetime policy and explain when and why a service will stop. Configured hard limits remain effective even while a preview is visible.
- Automatically sleeping services can wake through their stable preview URL or explicit controls without a model run. Manually stopped services require an explicit start action.
- Unexpected process exits trigger at most three automatic restart attempts with backoff before a visible failed state. Persist retry accounting through controller restarts so a crash loop cannot retry forever.
- Deliberate stops, idle shutdown, and enforced lifetime/resource limits do not trigger crash recovery.
- Keep source files, uncommitted changes, and persistent application data until explicit deletion by default. Stopping compute and deleting data are separate operations.
- Explicit task data deletion reviews all affected services, linked tasks, remote sandboxes and retained local checkouts. Require completed or cancelled tasks and stopped services, prevent new work after acceptance, and preserve per-resource cleanup progress across failures. Release retained capacity only after every reviewed resource is confirmed deleted; protect replacement resources and shared project history.
- Show retained storage usage and support administrator-configured retention. Expiration must be visible rather than silently inheriting a provider's deletion defaults.
- Automatic data deletion is opt-in at company scope. Show the configured interval, dependency protection and scheduled expiration. Every policy save gives existing data at least a full interval; subsequent service, task or agent activity extends that deadline. Recheck policy and all shared consumers before accepting a durable deletion job. Disabling retention prevents future acceptance but does not cancel an already accepted deletion. Record policy-triggered cleanup as a system action with its authorizing policy revision.
- Retention must remain valid through normal sandbox stop/archive/replacement operations. Select suitable persistence rather than assuming a deleted sandbox can restore itself.
- Recovery must not silently discard changes or replace application data with a fresh environment. If retained state is unavailable, show that condition and a concrete recovery path.
- If a host working copy disappears while its sandbox survives, recover from verified saved state and continue using the original sandbox and preview. Preserve its uncommitted source and application data. A different checkout at the old path must remain untouched; interrupted recovery must verify ownership before resuming or cleaning up temporary copies. Linked worktrees must preserve their shared project history.
- Do not promise preservation of RAM or live connections on providers that cannot provide it. Explain when a restart requires browser reconnection or loses in-memory state.

## 8. Task properties and user controls

- When a run creates or registers a service, automatically associate it with that run and its task.
- Show associated services in the task's properties pane without requiring manual attachment.
- Display each service's name, state, readiness, available URLs, and effective lifetime policy using concise product language.
- Provide appropriate start, stop, restart, open-URL, copy-URL, and logs controls. Expose authorized lifetime adjustments and sharing controls through the service UI.
- Keep services discoverable after the originating run ends or the task completes.
- Show multiple services clearly and distinguish their endpoints. Services without URLs still have useful state and controls.
- Provide a company-level service inventory in addition to task-level access.

### Interaction quality

- Controls respond immediately with visible feedback. Use optimistic updates where safe while distinguishing a requested action from confirmed operational state; accepting a start request must not imply readiness.
- Prevent accidental duplicate actions and handle rapid or conflicting interactions predictably.
- Reconcile the UI with authoritative server state, including changes initiated by agents or another user.
- Creating a service opens its detail with the name, status and primary controls visible, even when submission happened at the bottom of an expanded form. Preserve normal browser Back/Forward scroll restoration.
- A lifetime draft remains saveable across unrelated service state changes. Reject a competing lifetime edit without discarding the user's draft; offer an explicit way to load the current settings. Retrying an uncertain save must reuse the original request.
- Failed actions leave accurate state, a clear explanation, and useful retry controls. Avoid stale optimistic success after a rejection or disconnection.
- Handle slow startup, network interruption, and reconnection without disappearing feedback or unbounded loading states.
- Use restrained microanimations to communicate transitions and completion. Respect reduced-motion preferences.
- Support keyboard and screen-reader use, accessible status announcements, and responsive desktop/mobile properties layouts.
- Follow Paperclip's design system and token rules. Keep infrastructure details in diagnostics unless they help the user choose an action.

## 9. Access, preview isolation, and resource control

- Enforce company boundaries and authorization for service management, logs, and preview access.
- Agents may manage services associated with their authorized task context by default, including services created by another agent continuing the same authorized work. Broader company service control requires an explicit grant.
- Derive task/run provenance from authenticated execution context. Caller-supplied associations and adapter events cannot expand authority.
- Persistence does not expand the agent's execution privileges: managed commands, files, environment access, and destinations remain within the authorized execution boundary. A service tool must not become arbitrary host execution for a sandboxed agent.
- Previews are private by default using Paperclip authentication or explicitly configured tailnet access. Optional share links require an explicit authorized sharing action, expire, and can be revoked.
- A share link grants access only to its intended preview; it does not grant service management, logs, or Paperclip API access. It respects manual stop and resource-limit policy.
- Give each hosted preview its own hostname, separate from Paperclip's authenticated UI and other previews. The existing Paperclip-owned registered domain may be reused with the required browser cookie boundary; a new registered domain is not required. Customer-owned domains are deferred.
- Treat preview content as arbitrary untrusted code. Isolate Paperclip authentication and preview access credentials from that code, and prevent one preview from reading or controlling another preview's cookies, browser storage, or service workers.
- DNS and routing must preserve instance/company/service boundaries. Validate host routing and upstream destinations, prevent stale mappings or recycled names from exposing another service, and prevent preview routing from reaching unintended internal or control-plane endpoints.
- Expose intended application ports without exposing runner control ports. Do not make every sandbox port public to obtain an app preview.
- Services receive explicitly authorized credentials rather than depending on expiring run credentials. Keep secret values out of descriptions, ordinary metadata, and logs.
- Operators can configure ordinary environment values and bind company secrets to a stopped service. Agents cannot use service creation to authorize themselves for new secrets. Changes preserve drafts on failure and reject incomplete bindings; uncertain responses can be retried without applying the change twice. Secret rotation applies at the next start, and unavailable credentials produce a clear launch error while Stop and saved logs remain accessible.
- Record lifecycle and sharing actions with their initiating actor and task/run context where available.
- Operators can cap running services and retained service allocations per company. Concurrent requests reserve capacity atomically, and stopping processes retain their slots until termination is confirmed. Services sharing an allocation consume one allocation slot. Lowering a running limit stops the newest excess services; lowering a retained-allocation limit blocks additional allocations without deleting files. Capacity limits apply to explicit starts, agent tools, and automatic preview wakeups.
- Apply configured resource limits, retention policies, and cleanup rules. Retries and recovery must not create untracked or duplicate billable allocations.

## 10. Acceptance scenarios

These are required product outcomes, not tests already performed. Exercise the core process-lifetime and development flows on both local and Daytona-backed execution; qualify stable hosted URLs and isolation on the hosted path.

### A. Storybook survives agent completion

An agent starts Storybook and returns a reachable link to a specific story. The task properties pane displays the service and controls. After the agent run ends, the story remains accessible and the controls continue working. Verification occurs after the originating run has actually ended.

### B. Create and iterate on a Vite React app

An agent creates a Vite React app, installs its dependencies, and starts its dev server as a managed service. Paperclip displays a working preview URL in the task properties pane.

The user opens the app. The agent edits a React component and the browser updates through hot reload without deploying a separate copy. After the run ends, the preview remains available. A subsequent run edits the same files, including the prior uncommitted changes, and hot reload continues working. The preview WebSocket succeeds through the actual exposure path.

### C. Return ten minutes later

The user returns within the default 60-minute idle window. The preview remains available with the same source files and persistent data, independently of the agent's shorter warm-session timeout.

### D. Return after automatic shutdown

The service sleeps after inactivity. Reloading the old hosted preview tab at the same application URL shows startup progress and restores the requested route without a model run. Persistent files and application data remain intact. The browser origin remains stable. A manually stopped service instead shows that it requires an explicit start.

### E. Multiple services share a sandbox

A frontend, API server, and active agent share a sandbox. Stopping the frontend leaves the API and agent operational. Ending the agent run leaves the API operational. The sandbox becomes eligible to stop only when no active consumer requires it, while retained data remains protected.

### F. Paperclip restarts

After Paperclip restarts, surviving services reappear with accurate state and working controls. Reconciliation does not launch duplicates, lose retention settings, or reset an exhausted crash-retry budget.

Repeat with the agent's host working copy missing while the sandbox and service still run. Restore the backed-up working copy, reconnect to the same allocation, and reconcile the sandbox's newer committed and uncommitted edits. The service keeps its process and preview URL. Kill the controller during restoration and retry; valid partial progress resumes, while a replaced working copy or staging directory is preserved and reported for repair.

### G. Tools and adapter events converge

An agent starts a service through a tool and a supported adapter later reports the same service. Paperclip maintains one record, one set of controls, and correct provenance. Duplicate or reordered events do not repeat actions or restore stale state. With no native events available, the explicit tool workflow still succeeds.

### H. Register an existing process

An agent registers a server previously launched through its shell. Paperclip either safely adopts it or reports and performs a managed relaunch within the authorized request. The result survives runner teardown and leaves no duplicate server or conflicting listener. Saving metadata alone cannot pass this scenario.

Also exercise registration in a later run that reuses an eligible warm runner and the same workspace. The current run must receive verified process ownership even when no process is spawned for that run. Ownership must not carry across a changed sandbox allocation or connection. A subsequent agent edit must hot-reload the same managed Vite preview without duplicating or restarting the service.

### I. Controls remain reliable under failure

Exercise slow startup, failed startup, repeated clicks, simultaneous user/agent actions, network interruption, and reconnection in the task properties pane. Feedback is immediate, pending states remain distinct from readiness, and the UI converges on actual service state. Verify keyboard use, reduced motion, and mobile layout.

Create a service from an expanded form scrolled to its footer and verify the resulting detail starts with the service name and status in view. Open a lifetime draft, stop or let the service sleep through another action, then save the draft successfully without starting it. A separate operator's lifetime edit must instead produce a clear conflict, preserve the draft, and allow the user to load the current settings. A lost save response must not apply the operation twice.

### J. Activity and policy behave as displayed

A visible preview remains running while the user reads without interacting. Hiding or closing it lets the 60-minute idle policy apply; background HTTP polling and health checks do not keep it alive. Authorized agent use renews activity. A configured maximum running duration still stops an active preview. A worker does not inherit dev-preview idle shutdown accidentally.

Also configure company defaults and caps through the UI. Verify new services inherit the idle default, existing services keep their saved policy, and a live company deadline overrides a longer per-service duration and keep-until hold. At capacity, concurrent starts and automatic wakes fail clearly without allocating extra compute. Lower a running cap during startup, verify excess services stop, and confirm that files remain available. A failed or uncertain company-policy save preserves the draft and safely retries the original request; another operator's edit cannot be overwritten silently.

### K. Crash recovery is bounded

A server crashes repeatedly. Paperclip retries up to three times with backoff, then shows failed state and accessible logs. Controller restart cannot create an endless retry loop. A user stop, idle sleep, or resource-limit stop does not trigger automatic crash restart.

### L. Preview access and arbitrary-code isolation

Unauthorized users cannot open private previews. An authorized expiring share link opens only its intended preview and fails after expiry or revocation. Preview code cannot access Paperclip session credentials, another service's browser state, or runner control ports. Invalid host routing and stale/reassigned mappings cannot cross instance, company, or service boundaries.

### M. Exposure or retained environment becomes unavailable

A provider preview credential expires, a service crashes, or a sandbox disappears. Paperclip distinguishes those conditions, renews or recovers only where supported, and offers a concrete recovery path otherwise. It does not claim readiness while the URL is unusable or silently serve a clean checkout when retained changes are missing.

### N. Task completion does not erase a service

Complete the originating task and allow normal workspace-cleanup eligibility to run. The service remains discoverable in task properties and the company inventory. Its source files and persistent data remain protected until service retention or explicit deletion authorizes removal.

## Release boundaries and engineering follow-up

- Hosted preview continuity, first-class agent tools, task properties controls, local/Daytona service execution, and the selected lifecycle defaults belong to the initial delivery.
- Customer-owned preview domains and adoption without restart are deferred. More elaborate self-hosted domain automation must not delay hosted delivery.
- Codex/ACPX event names and guarantees must be verified against supported versions during implementation design; this requirements document does not assume a native service API exists.
- The implementation plan must specify supervision, allocation retention, authenticated routing, browser-visibility signaling for arbitrary apps, durable data storage, restart reconciliation, and compatibility with existing controls. Those mechanisms must satisfy these requirements without shifting infrastructure decisions onto end users.
- This document does not authorize a production rollout or change existing V1 security boundaries. Any necessary contract changes must be made explicitly across the affected layers during implementation.
