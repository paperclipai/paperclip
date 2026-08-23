# FirstMate Manual Heartbeat Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make taskless manual FirstMate heartbeats dispatch successfully and make relay rejections fail immediately.

**Architecture:** Change only the custom `firstmate_gateway` adapter. It will synthesize a stable relay correlation ID for taskless runs and treat a matching negative dispatch acknowledgement as a terminal adapter error.

**Tech Stack:** TypeScript, Node.js test runner, `ws`, pnpm, Docker Compose, Paperclip authenticated API.

## Global Constraints

- Do not change the MCP relay, Coding agent, database contents, or Paperclip core.
- Preserve task-backed dispatch behavior and lifecycle identity checks.
- Use `heartbeat:<runId>` only when `context.task.id` is absent.
- Return `FIRSTMATE_REJECTED` immediately for a matching acknowledgement whose `accepted` field is not `true`.
- Recreate only the Paperclip application container; do not restart PostgreSQL, MCP relay, nginx, or the Coding relay agent.
- Preserve the prior Paperclip image ID for rollback.

---

### Task 1: Test and implement taskless dispatch and rejection handling

**Files:**
- Modify: `packages/adapters/firstmate-gateway/src/server/execute.test.ts`
- Modify: `packages/adapters/firstmate-gateway/src/server/execute.ts`

**Interfaces:**
- Consumes: `AdapterExecutionContext.context.task`, `AdapterExecutionContext.runId`, and relay `paperclip.dispatch_ack` frames.
- Produces: `paperclip.dispatch.taskId` with a real or synthetic value and immediate `AdapterExecutionResult` errors with code `FIRSTMATE_REJECTED`.

- [ ] **Step 1: Add a failing taskless-dispatch regression test**

Add a WebSocket relay test that executes with `context: {}` and captures the dispatch frame:

```ts
test("uses a stable synthetic task ID for a taskless heartbeat", async () => {
  // Start the local WebSocketServer using the existing test pattern.
  // On paperclip.dispatch, assert frame.taskId === "heartbeat:run-taskless".
  // Send accepted:true and a matching completed lifecycle event.
  // Assert exitCode === 0.
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import "$TSX_LOADER" --test packages/adapters/firstmate-gateway/src/server/execute.test.ts
```

Expected: the new test fails because the dispatched `taskId` is null rather than `heartbeat:run-taskless`; the existing test passes.

- [ ] **Step 3: Add a failing negative-acknowledgement regression test**

```ts
test("fails immediately when the relay rejects dispatch", async () => {
  // Start the local WebSocketServer using the existing test pattern.
  // After paperclip.dispatch, send:
  // { type: "paperclip.dispatch_ack", runId: frame.runId,
  //   accepted: false, error: "invalid_dispatch" }
  // Assert timedOut === false, exitCode === 1,
  // errorCode === "FIRSTMATE_REJECTED", and the error mentions invalid_dispatch.
});
```

- [ ] **Step 4: Run the focused test and verify RED**

Run the same focused command. Expected: the rejection test resolves only through the timeout path and fails its `FIRSTMATE_REJECTED` assertion.

- [ ] **Step 5: Implement the minimal adapter change**

Extend the frame type and resolve a dispatch ID:

```ts
type Frame = {
  type?: unknown;
  runId?: unknown;
  agentId?: unknown;
  kind?: unknown;
  message?: unknown;
  accepted?: unknown;
  error?: unknown;
};

const taskId = text(asRecord(context.context.task).id) ?? `heartbeat:${context.runId}`;
```

Send `taskId` in `paperclip.dispatch`. Handle every matching acknowledgement:

```ts
if (frame.type === "paperclip.dispatch_ack" && frame.runId === context.runId) {
  if (frame.accepted === true) {
    acknowledged = true;
    await context.onLog("stdout", "FirstMate accepted Paperclip run.\n");
    return;
  }
  const reason = text(frame.error);
  finish({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: reason
      ? `FirstMate Gateway rejected the run: ${reason}.`
      : "FirstMate Gateway rejected the run.",
    errorCode: "FIRSTMATE_REJECTED",
  });
  return;
}
```

- [ ] **Step 6: Run focused tests and typecheck for GREEN**

```bash
node --import "$TSX_LOADER" --test packages/adapters/firstmate-gateway/src/server/execute.test.ts
pnpm --filter @paperclipai/adapter-firstmate-gateway typecheck
```

Expected: all focused tests pass and TypeScript reports zero errors.

- [ ] **Step 7: Commit the adapter fix**

```bash
git add packages/adapters/firstmate-gateway/src/server/execute.ts \
  packages/adapters/firstmate-gateway/src/server/execute.test.ts
git commit -m "fix: dispatch taskless FirstMate heartbeats"
```

### Task 2: Deploy and verify the live heartbeat

**Files:**
- Deploy: `packages/adapters/firstmate-gateway/src/server/execute.ts`
- Deploy: `packages/adapters/firstmate-gateway/src/server/execute.test.ts`

**Interfaces:**
- Consumes: the tested Task 1 commit and the existing `paperclip` Docker Compose service.
- Produces: a recreated Paperclip application container and one terminal taskless heartbeat run.

- [ ] **Step 1: Capture rollback state and verify unrelated services**

```bash
docker inspect --format '{{.Image}}' paperclip-paperclip-1
systemctl is-active paperclip.service
docker ps --filter name=paperclip-postgres-1 --format '{{.Status}}'
ssh mcp systemctl is-active firstmate-realtime-server.service nginx.service
ssh coding systemctl is-active firstmate-realtime-agent.service
```

Expected: prior image ID is recorded and every service is active/healthy.

- [ ] **Step 2: Install only the two tested adapter files into the live source**

Verify the live pre-edit hashes still match the files copied into the worktree at isolation time:

```bash
printf '%s  %s\n' \
  '2b77c733c70dd269418e21679f7b60b9c6adaef7b56dbcadb63fb7f98b0fa9e2' \
  'packages/adapters/firstmate-gateway/src/server/execute.ts' \
  '17b446717af3737420b64b1e5a1045fb3d974e233159d81cebd90b071a037ae9' \
  'packages/adapters/firstmate-gateway/src/server/execute.test.ts' | sha256sum -c -
```

Stop on any mismatch. Back up those two exact live files with their owner, mode, and SHA-256, then install the tested worktree versions with the same metadata.

- [ ] **Step 3: Build and recreate only the application service**

```bash
sudo docker compose --env-file /etc/paperclip/paperclip.env \
  -f /opt/paperclip/compose.yaml build paperclip
sudo docker compose --env-file /etc/paperclip/paperclip.env \
  -f /opt/paperclip/compose.yaml up -d --no-deps paperclip
```

Expected: PostgreSQL container ID is unchanged; the Paperclip application becomes healthy.

- [ ] **Step 4: Run pre-heartbeat health gates**

```bash
curl -fsS http://127.0.0.1:3100/api/health
systemctl is-active paperclip.service
ssh mcp systemctl is-active firstmate-realtime-server.service nginx.service
ssh coding systemctl is-active firstmate-realtime-agent.service
```

Expected: Paperclip returns `status=ok`; all relay services remain active.

- [ ] **Step 5: Invoke one authenticated taskless heartbeat**

Use a temporary supported Paperclip board-auth session. First run the prospective `firstmate_gateway` environment test for agent `229f951e-ff33-44c7-af25-fcce30506971` and require `status=pass`. Then invoke its taskless heartbeat and revoke the temporary session in a `finally` block.

Expected relay flow: a `paperclip.accepted` event exists for the new run, Paperclip records `FirstMate accepted Paperclip run.`, and the run reaches a terminal state rather than remaining acknowledgement-silent.

- [ ] **Step 6: Verify final state and rollback if necessary**

Verify the new run has a terminal `succeeded` or `failed` state with at least an acknowledgement event. If acknowledgement is absent or the application is unhealthy, redeploy the recorded prior image and report the failed gate. Do not alter the database manually.

- [ ] **Step 7: Record deployment result**

Record the tested commit, new image ID, heartbeat run ID/status, active-service checks, and confirmation that PostgreSQL/MCP/nginx/Coding services were not restarted.
