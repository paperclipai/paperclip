import { describe, expect, it, vi } from "vitest";
import { retainedLocalProviderProcesses } from "./retained-local-stop.js";
import { validatePrpEvent } from "../../vendor/paperclip-runner/index.js";

export function retainedStopFixture() {
  const identity = {
    runnerInstanceId: "runner-1",
    environmentLeaseId: "workspace-1",
    runId: "run-1",
    normalizedSessionId: "session-1",
    turnId: "turn-1",
    itemId: "item-1",
  };
  const events = ["intent", "spawned", "intent", "spawned"].map(
    (phase, index) => {
      const generation = index < 2 ? 2 : 3;
      const event = {
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "harness.diagnostic",
        sourceKind: "runner",
        sourceInstanceId: identity.runnerInstanceId,
        sourceEventId: `event-${index + 1}`,
        sourceSeq: index + 1,
        runId: identity.runId,
        normalizedSessionId: identity.normalizedSessionId,
        turnId: identity.turnId,
        itemId: identity.itemId,
        priority: 1,
        emittedAt: "2026-09-11T10:00:00.000Z",
        payload: {
          startup: {
            schema: "paperclip.provider_startup.v1",
            origin: { ...identity },
            launchId: `launch-${generation}`,
            attemptedProcessGeneration: generation,
            phase,
            processId: phase === "spawned" ? 999999990 + generation : null,
            processGroupId: phase === "spawned" ? 999999990 + generation : null,
          },
        },
      };
      return {
        sourceSeq: index + 1,
        envelope: { ...identity, payload: event },
      };
    },
  );
  const snapshot = {
    fingerprint: "fixture",
    fileSha256: ["a", "b", "c"] as const,
    control: {
      schema: "paperclip.runner.durable.control-plane-state.v1",
      identity: { ...identity },
      tickets: { ticket: { expiresAt: "2026-09-11T10:01:00Z" } },
      leases: { lease: { expiresAt: "2026-09-11T11:00:00Z" } },
      commands: [
        { type: "session.snapshot", status: "pending", controllerSeq: 14 },
      ],
      committedEvents: events,
      ackedSourceSeq: events.length,
    },
    runner: {
      schema: "paperclip.runner.durable.state.v1",
      ...identity,
      lifecycle: "suspended",
      pendingTerminalDelivery: null as unknown,
      pendingProviderCleanup: null as unknown,
      outbox: [] as unknown[],
      ackedSourceSeq: events.length,
      nextSourceSeq: events.length + 1,
      lastControllerCommandSeq: 13,
    },
    provider: {
      schema: "paperclip.runner.codex-provider-state.v1",
      lifecycle: "prepared",
      startupAttempt: null as unknown,
      providerProcessGeneration: 3,
      pendingEvents: [] as unknown[],
      queuedEvents: [] as unknown[],
      toolBridge: { pending: {} },
      activeProviderTurnId: null as string | null,
      ambiguousTurnStartPending: false,
    },
  };
  return { identity, snapshot, now: new Date("2026-09-11T12:00:00Z") };
}

describe("retained local provider inventory", () => {
  it("recovers every recorded launch from the complete suspended journal", () => {
    const f = retainedStopFixture();
    for (const entry of f.snapshot.control.committedEvents)
      expect(
        validatePrpEvent(entry.envelope.payload),
        JSON.stringify(validatePrpEvent(entry.envelope.payload)),
      ).toMatchObject({ ok: true });
    expect(retainedLocalProviderProcesses(f)).toEqual([999999992, 999999993]);
  });
  it.each([
    "foreign_scope",
    "foreign_event",
    "foreign_launch",
    "live_runner",
    "pending_delivery",
    "outbox",
    "live_provider",
    "startup_intent",
    "active_turn",
    "ambiguous_turn",
    "ticket",
    "lease",
    "missing_event",
    "new_generation",
    "missing_spawn",
    "bad_pid",
    "wrong_group",
    "pending_launch",
    "bad_schema",
    "missing_credentials",
    "duplicate_sequence",
    "provider_cleanup",
    "uncommitted_provider_event",
  ])("rejects incomplete or unsettled evidence: %s", (kind) => {
    const f = retainedStopFixture();
    const { control, runner, provider } = f.snapshot;
    const event = control.committedEvents[0]!.envelope.payload;
    const spawned =
      control.committedEvents[3]!.envelope.payload.payload.startup;
    switch (kind) {
      case "uncommitted_provider_event":
        provider.pendingEvents.push({ eventType: "harness.diagnostic" });
        break;
      case "foreign_scope":
        control.identity.runId = "other";
        break;
      case "foreign_event":
        event.sourceInstanceId = "other";
        break;
      case "foreign_launch":
        event.payload.startup.origin.runId = "other";
        break;
      case "live_runner":
        runner.lifecycle = "ready";
        break;
      case "pending_delivery":
        runner.pendingTerminalDelivery = {};
        break;
      case "provider_cleanup":
        runner.pendingProviderCleanup = {};
        break;
      case "outbox":
        runner.outbox.push({});
        break;
      case "live_provider":
        provider.lifecycle = "turn_active";
        break;
      case "startup_intent":
        provider.startupAttempt = {};
        break;
      case "active_turn":
        provider.activeProviderTurnId = "turn";
        break;
      case "ambiguous_turn":
        provider.ambiguousTurnStartPending = true;
        break;
      case "ticket":
        control.tickets.ticket.expiresAt = "2026-09-12T00:00:00Z";
        break;
      case "lease":
        control.leases.lease.expiresAt = "invalid";
        break;
      case "missing_credentials":
        control.leases = {} as typeof control.leases;
        break;
      case "missing_event":
        control.committedEvents.shift();
        break;
      case "new_generation":
        provider.providerProcessGeneration++;
        break;
      case "missing_spawn":
        spawned.phase = "intent";
        break;
      case "bad_pid":
        spawned.processId = -1;
        break;
      case "wrong_group":
        spawned.processGroupId = 42;
        break;
      case "pending_launch":
        control.commands[0]!.type = "run.attach";
        break;
      case "bad_schema":
        runner.schema = "unknown";
        break;
      case "duplicate_sequence":
        event.sourceSeq = 2;
        break;
    }
    expect(retainedLocalProviderProcesses(f)).toBeNull();
  });
});

describe("retained local stop host verification", () => {
  it.each([
    "stopped",
    "live_controller",
    "live_provider",
    "permission_denied",
    "foreign_company",
    "newer_lease",
    "symlink",
    "missing_file",
  ])(
    "checks persisted scope and real host evidence: %s",
    async (kind) => {
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } =
        await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { createHash } = await import("node:crypto");
      const { canonicalNativeJson } = await import("./canonical.js");
      const { verifyRetainedLocalProcessStop } =
        await import("./native-session-executor.js");
      const f = retainedStopFixture();
      const base = mkdtempSync(join(tmpdir(), "retained-stop-"));
      const previousBase = process.env.PAPERCLIP_RUNNER_STATE_DIR;
      process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
      const execution = {
        schema: "paperclip.native-execution-input.v1",
        provider: { kind: "codex", model: null },
        binding: {
          companyId: "company",
          agentId: "agent",
          issueId: "issue",
          runId: "run-1",
          executionWorkspaceId: "workspace-1",
        },
        task: {
          identifier: "TEST-1",
          title: "Continue",
          description: null,
          prompt: "Continue",
          workMode: "standard",
        },
        workspace: {
          cwd: base,
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        session: {
          normalizedSessionId: "session-1",
          driverKind: "codex_app_server",
          protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        },
        completionContract: {
          id: "contract",
          sha256: "sha",
          schemaVersion: "paperclip.completion-contract.v1",
          contract: {
            revision: "1",
            objective: "Continue",
            criteria: [{ id: "objective", requirement: "Finish" }],
          },
        },
        interactionResponses: [],
        credentialBindings: [],
      };
      const run = {
        id: "run-1",
        companyId: "company",
        agentId: "agent",
        nativeIssueId: "issue",
        runtimeMode: "native",
        status: "failed",
        finishedAt: new Date("2026-09-11T11:00:00Z"),
        errorCode: "native_runner_process_exited",
        processPid: null,
        processGroupId: null,
        nativeSessionId: "session-1",
        runnerInstanceId: "runner-1",
        runnerProfileJson: { nativeExecutionInput: execution },
      } as unknown as Parameters<typeof verifyRetainedLocalProcessStop>[0];
      const coordinator = {
        companyId: "company",
        issueId: "issue",
        runId: "run-1",
        phase: "terminal_failure",
        controllerPid: kind === "live_controller" ? process.pid : 999999999,
      } as Parameters<typeof verifyRetainedLocalProcessStop>[1];
      const scope = canonicalNativeJson({
        schema: "paperclip.native-session-scope.v2",
        companyId: "company",
        agentId: "agent",
        workspace: { kind: "managed", executionWorkspaceId: "workspace-1" },
        provider: {
          driverKind: "codex_app_server",
          identity: { kind: "codex" },
        },
        normalizedSessionId: "session-1",
      });
      const root = join(base, createHash("sha256").update(scope).digest("hex"));
      mkdirSync(join(root, "runner"), { recursive: true });
      mkdirSync(join(root, "control-plane"));
      if (kind === "live_provider") {
        const startup =
          f.snapshot.control.committedEvents[3]!.envelope.payload.payload
            .startup;
        startup.processId = process.pid;
        startup.processGroupId = process.pid;
      }
      if (kind === "foreign_company") execution.binding.companyId = "other";
      if (kind === "newer_lease") coordinator.leaseOwner = "active";
      for (const [name, value] of [
        ["control-plane/control-plane-state.json", f.snapshot.control],
        ["runner/runner-state.json", f.snapshot.runner],
        ["runner/codex-provider-state.json", f.snapshot.provider],
      ] as const)
        writeFileSync(join(root, name), JSON.stringify(value));
      if (kind === "symlink" || kind === "missing_file") {
        rmSync(join(root, "runner/codex-provider-state.json"));
        if (kind === "symlink") {
          writeFileSync(
            join(base, "provider.json"),
            JSON.stringify(f.snapshot.provider),
          );
          symlinkSync(
            join(base, "provider.json"),
            join(root, "runner/codex-provider-state.json"),
          );
        }
      }
      const kill =
        kind === "permission_denied"
          ? vi.spyOn(process, "kill").mockImplementation(() => {
              throw Object.assign(new Error("denied"), { code: "EPERM" });
            })
          : null;
      try {
        const result = verifyRetainedLocalProcessStop(run, coordinator);
        if (kind === "stopped")
          expect(result).toMatchObject({
            providerProcessIds: [999999992, 999999993],
            controllerPid: 999999999,
          });
        else expect(result).toBeNull();
      } finally {
        kill?.mockRestore();
        if (previousBase === undefined)
          delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
        else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousBase;
        rmSync(base, { recursive: true, force: true });
      }
    },
    30000,
  );
});
