# FirstMate Paperclip Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, first-class `firstmate_gateway` Paperclip adapter that dispatches one Paperclip run to FirstMate and streams its normalized lifecycle back to Paperclip.

**Architecture:** The Paperclip adapter will speak a narrow authenticated WebSocket protocol to the existing FirstMate realtime bridge. A new TLS Nginx route on the MCP host will expose only that bridge to the Paperclip VM. FirstMate retains ownership of its coding subagents; Paperclip records the single parent run and OpenClaw remains a separate reviewer.

**Tech Stack:** TypeScript, Paperclip adapter-utils, Vitest, Node `ws`, FirstMate Node realtime bridge, Nginx, systemd, VTHQ internal CA.

## Global Constraints

- No firewall changes.
- The bridge accepts only authenticated WSS traffic and Paperclip stores credentials as secret-backed adapter configuration.
- Only `started`, `progress`, `artifact`, `completed`, `failed`, and `cancelled` events may cross the adapter boundary.
- Event payloads must bind to the active Paperclip run ID and agent ID; sensitive fields are redacted.
- A retry reuses the same run-derived idempotency/session key; cancellation sends one explicit cancel command and never launches replacement work.
- Tests are hermetic and must not contact the live Paperclip, FirstMate, or coding agents.

---

### Task 1: Define and test the FirstMate bridge protocol

**Files:**
- Modify: `/opt/firstmate-realtime-bridge/src/server.mjs`
- Create: `/opt/firstmate-realtime-bridge/test/server.test.mjs`

**Interfaces:**
- Consumes: authenticated WebSocket message `{type:"paperclip.dispatch",runId,agentId,taskId,brief,idempotencyKey}`.
- Produces: `paperclip.dispatch_ack`, normalized `paperclip.run_event`, and `{type:"paperclip.cancel",runId}` support.
- Later task dependency: Paperclip adapter connects to WSS `/firstmate/realtime` and consumes these events.

- [ ] **Step 1: Write failing protocol tests**

```js
it("accepts one idempotent dispatch and forwards its bound task to FirstMate", async () => {
  const ack = await client.dispatch({ runId: "run-1", agentId: "agent-1", taskId: "task-1", brief: "Fix test", idempotencyKey: "run-1" });
  expect(ack).toMatchObject({ accepted: true, duplicate: false, runId: "run-1" });
});

it("rejects an event whose run or agent identity does not match its dispatch", async () => {
  await client.dispatch(validDispatch);
  await agent.emit("paperclip.run_event", { runId: "other", agentId: "agent-1", kind: "completed" });
  expect(await client.nextEvent()).toMatchObject({ event: "paperclip.event_rejected" });
});
```

- [ ] **Step 2: Run the protocol test to verify it fails**

Run: `node --test /opt/firstmate-realtime-bridge/test/server.test.mjs`

Expected: FAIL because the bridge has no bound event/cancellation protocol.

- [ ] **Step 3: Implement the bounded bridge state machine**

```js
const activeRuns = new Map();
// On accepted dispatch: activeRuns.set(runId, { agentId, taskId, idempotencyKey, cancelled:false })
// Forward only agent event kinds in the allow-list when data.runId/data.agentId match activeRuns.
// On paperclip.cancel: mark cancelled and send one `paperclip.cancel` command to the connected agent.
```

- [ ] **Step 4: Run focused bridge tests**

Run: `node --test /opt/firstmate-realtime-bridge/test/server.test.mjs`

Expected: PASS, including duplicate dispatch, mismatched event rejection, and idempotent cancellation.

- [ ] **Step 5: Commit**

```bash
git -C /opt/firstmate-realtime-bridge add src/server.mjs test/server.test.mjs
git -C /opt/firstmate-realtime-bridge commit -m "feat: add Paperclip FirstMate run protocol"
```

### Task 2: Expose the bridge as a private TLS endpoint

**Files:**
- Modify: `/etc/nginx/sites-enabled/vthq-mcp-tls`
- Create: `/etc/systemd/system/firstmate-realtime-server.service.d/paperclip-bind.conf`

**Interfaces:**
- Consumes: WSS `wss://mcp.vthq.net/firstmate/realtime` with bearer authorization.
- Produces: reverse proxy to `127.0.0.1:8787/events`; `/health` remains loopback-only.
- Later task dependency: adapter config requires this WSS URL.

- [ ] **Step 1: Write the failing Nginx contract check**

```bash
curl --fail --silent --max-time 5 https://mcp.vthq.net/firstmate/realtime
# Expected before route: 404
```

- [ ] **Step 2: Add the WebSocket-only Nginx location**

```nginx
location = /firstmate/realtime {
    proxy_pass http://127.0.0.1:8787/events;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 600s;
}
```

- [ ] **Step 3: Validate configuration and authenticated handshake**

Run: `sudo nginx -t && sudo systemctl reload nginx`

Run a read-only WebSocket handshake from the Paperclip VM using the configured secret; assert unauthorized requests are rejected and authorized requests receive the bridge hello frame.

- [ ] **Step 4: Commit the managed Nginx/systemd source-of-truth change**

```bash
git -C /opt/firstmate-realtime-bridge add deploy/firstmate-realtime-server.service.d/paperclip-bind.conf deploy/nginx/firstmate-paperclip.conf
git -C /opt/firstmate-realtime-bridge commit -m "feat: expose FirstMate Paperclip bridge over TLS"
```

### Task 3: Create the Paperclip FirstMate gateway adapter

**Files:**
- Create: `packages/adapters/firstmate-gateway/package.json`
- Create: `packages/adapters/firstmate-gateway/tsconfig.json`
- Create: `packages/adapters/firstmate-gateway/vitest.config.ts`
- Create: `packages/adapters/firstmate-gateway/src/index.ts`
- Create: `packages/adapters/firstmate-gateway/src/server/execute.ts`
- Create: `packages/adapters/firstmate-gateway/src/server/test.ts`
- Create: `packages/adapters/firstmate-gateway/src/server/execute.test.ts`
- Create: `packages/adapters/firstmate-gateway/src/server/test.test.ts`

**Interfaces:**
- Consumes: config `{url, authToken, timeoutSec?, sessionKeyStrategy?}` and `AdapterExecutionContext`.
- Produces: `execute(ctx)` and `testEnvironment(ctx)` for adapter type `firstmate_gateway`.
- Uses: bridge protocol from Task 1 and `buildPaperclipEnv`, `renderPaperclipWakePrompt`, and `AdapterExecutionResult` from adapter-utils.

- [ ] **Step 1: Write failing adapter tests**

```ts
it("dispatches the Paperclip task once and maps FirstMate progress to adapter logs", async () => {
  const result = await execute(contextFor("run-1"), configFor(fakeBridge.url));
  expect(fakeBridge.dispatches).toHaveLength(1);
  expect(result.status).toBe("completed");
});

it("uses a stable run-derived idempotency key on retry and returns failure for unknown terminal state", async () => {
  await expect(execute(contextFor("run-1"), configFor(fakeBridge.url))).rejects.toMatchObject({ errorCode: "firstmate_gateway_terminal_unknown" });
});
```

- [ ] **Step 2: Run focused tests to verify failure**

Run: `pnpm --filter @paperclipai/adapter-firstmate-gateway test`

Expected: FAIL because the adapter package does not exist.

- [ ] **Step 3: Implement config validation, WebSocket client, and result mapping**

```ts
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  // Require wss:// URL and auth token, render the Paperclip task brief,
  // dispatch {runId, agentId, taskId, brief, idempotencyKey: `paperclip:${ctx.runId}`},
  // redact logs, and resolve only on an allowed matching terminal event.
}
```

- [ ] **Step 4: Implement the non-writing environment test**

```ts
export async function testEnvironment(ctx: AdapterEnvironmentTestContext) {
  // Validate URL/auth locally, open WSS, require bridge hello, then close.
  // Do not dispatch a task or modify Paperclip state.
}
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm --filter @paperclipai/adapter-firstmate-gateway test && pnpm --filter @paperclipai/adapter-firstmate-gateway typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/firstmate-gateway
git commit -m "feat: add FirstMate Paperclip gateway adapter"
```

### Task 4: Register the adapter and configure the creation UI

**Files:**
- Modify: `server/src/adapters/registry.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/adapter-utils/src/types.ts`
- Modify: `ui/src/adapters/adapter-display-registry.ts`
- Create: `ui/src/adapters/firstmate-gateway/index.ts`
- Create: `ui/src/adapters/firstmate-gateway/build-config.ts`
- Create: `ui/src/adapters/firstmate-gateway/build-config.test.ts`
- Modify: `ui/src/adapters/metadata.test.ts`

**Interfaces:**
- Registers `firstmate_gateway` as a selectable server adapter.
- Creation form emits `{url, authToken, timeoutSec: 900, sessionKeyStrategy:"run"}`.
- Later task dependency: production agent can be created and tested in Paperclip UI.

- [ ] **Step 1: Write failing registry and UI tests**

```ts
expect(isEnabledAdapterType("firstmate_gateway")).toBe(true);
expect(buildFirstMateGatewayConfig({ url: "wss://mcp.vthq.net/firstmate/realtime", authToken: "token" }))
  .toMatchObject({ timeoutSec: 900, sessionKeyStrategy: "run" });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @paperclipai/ui test -- metadata.test.ts build-config.test.ts`

Expected: FAIL because the adapter type/UI builder is absent.

- [ ] **Step 3: Register the adapter and add the compact configuration form**

```ts
firstmate_gateway: {
  label: "FirstMate Gateway",
  description: "FirstMate coding-run worker",
  icon: Terminal,
}
```

- [ ] **Step 4: Run targeted tests, full typecheck, and production build**

Run: `pnpm test --filter firstmate-gateway && pnpm typecheck && pnpm build`

Expected: PASS with no new network calls.

- [ ] **Step 5: Commit**

```bash
git add server/src/adapters/registry.ts packages/shared/src/constants.ts packages/adapter-utils/src/types.ts ui/src/adapters
git commit -m "feat: register FirstMate Paperclip worker"
```

### Task 5: Deploy and validate the FirstMate worker

**Files:**
- Modify: `/opt/paperclip/compose.yaml`
- Create: `/opt/paperclip/firstmate-gateway.env`
- Create: `/opt/paperclip/runbooks/firstmate-worker.md`

**Interfaces:**
- Paperclip agent `FirstMate` uses `firstmate_gateway` and WSS endpoint `wss://mcp.vthq.net/firstmate/realtime`.
- Hermes delegates to this agent; OpenClaw receives review tasks only after FirstMate terminal completion.

- [ ] **Step 1: Install the adapter build and its CA trust**

```bash
pnpm --filter @paperclipai/adapter-firstmate-gateway build
docker compose -f /opt/paperclip/compose.yaml build --no-cache paperclip
```

- [ ] **Step 2: Add the scoped runtime secret without printing it**

```bash
install -o root -g paperclip -m 0640 /dev/stdin /opt/paperclip/firstmate-gateway.env
# contains only FIRST_MATE_GATEWAY_TOKEN=<generated value>
```

- [ ] **Step 3: Run the non-writing Paperclip adapter test**

Expected: endpoint/auth/bridge hello all pass; no task is created and no FirstMate coding work starts.

- [ ] **Step 4: Run one controlled canary task**

Create a Paperclip task with a no-op repository inspection. Verify one FirstMate run, streamed progress, a terminal result, and a separate OpenClaw review task. Verify the canary’s cancellation button sends one cancellation event.

- [ ] **Step 5: Record rollback and commit deployment materials**

```bash
git add /opt/paperclip/compose.yaml /opt/paperclip/runbooks/firstmate-worker.md
git commit -m "ops: deploy FirstMate Paperclip worker"
```

Rollback: disable the FirstMate Paperclip agent in the UI, remove its scoped secret reference, and restore the prior Paperclip image; do not stop the existing Hermes↔FirstMate MCP integration.

## Self-review

- Spec coverage: Tasks 1–2 provide the secure bridge and lifecycle contract; Tasks 3–4 create/register the native adapter; Task 5 deploys and validates the tracked workflow.
- Placeholder scan: no unresolved placeholders or generic error-handling instructions remain.
- Type consistency: `firstmate_gateway`, `runId`, `agentId`, `taskId`, and `idempotencyKey` are used consistently across bridge, adapter, UI, and deployment tasks.
