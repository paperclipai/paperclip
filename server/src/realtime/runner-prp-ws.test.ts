import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { DurablePrpControlPlane } from "@paperclipai/paperclip-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  queueLiveRunnerPrpCommand,
  queueRunnerPrpRuntimeRequestResolution,
  registerRunnerPrpAuthority,
  RunnerPrpRuntimeRequestResolutionError,
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "./runner-prp-ws.js";

describe("runner PRP websocket route", () => {
  afterEach(() => runnerPrpWebSocketInternals.resetForTests());

  it("routes only the registered run and releases it by generation", async () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3210" });
    const handleUpgrade = vi.fn();
    const runId = "00000000-0000-4000-8000-000000000777";
    const registration = await registerRunnerPrpAuthority({
      companyId: "company-1",
      runId,
      authority: { handleUpgrade } as unknown as DurablePrpControlPlane,
    });

    expect(registration.connectUrl).toBe(
      `ws://127.0.0.1:3210/api/runner/v1/connect/${runId}`,
    );
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: "company-1",
        runId,
      }),
    ).toBe(true);

    const socket = new PassThrough();
    const request = { url: `/api/runner/v1/connect/${runId}`, headers: {} };
    server.emit("upgrade", request, socket, Buffer.alloc(0));
    expect(request).toMatchObject({ paperclipWebSocketHandled: true });
    expect(handleUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ url: `/api/runner/v1/connect/${runId}` }),
      socket,
      `/api/runner/v1/connect/${runId}`,
      expect.any(Buffer),
    );

    await registration.release();
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: "company-1",
        runId,
      }),
    ).toBe(false);
    server.close();
  });

  it.each([
    ["/api/runner/v1/connect/not-a-run", "400 Bad Request"],
    [
      "/api/runner/v1/connect/00000000-0000-4000-8000-000000000778",
      "404 Not Found",
    ],
  ])("fails closed for %s", (path, expectedStatus) => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3211" });
    const socket = new PassThrough();
    const writes: Buffer[] = [];
    socket.on("data", (chunk) => writes.push(Buffer.from(chunk)));
    server.emit("upgrade", { url: path, headers: {} }, socket, Buffer.alloc(0));
    expect(Buffer.concat(writes).toString("utf8")).toContain(expectedStatus);
    server.close();
  });

  it("does not replace an active registration", async () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3212" });
    const runId = "00000000-0000-4000-8000-000000000779";
    const authority = {
      handleUpgrade: vi.fn(),
    } as unknown as DurablePrpControlPlane;
    const first = await registerRunnerPrpAuthority({
      companyId: "company-1",
      runId,
      authority,
    });
    await expect(
      registerRunnerPrpAuthority({ companyId: "company-2", runId, authority }),
    ).rejects.toThrow("runner_prp_authority_already_registered");
    await first.release();
    server.close();
  });

  it("routes live commands only to the newest generation", async () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3214" });
    const oldRunId = "00000000-0000-4000-8000-000000000781";
    const newRunId = "00000000-0000-4000-8000-000000000782";
    const oldQueueCommand = vi.fn(() => ({
      commandId: "old-command",
      controllerSeq: 1,
    }));
    const newQueueCommand = vi.fn(() => ({
      commandId: "new-command",
      controllerSeq: 2,
    }));
    const oldRegistration = await registerRunnerPrpAuthority({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: oldRunId,
      authority: {
        queueCommand: oldQueueCommand,
        commandOutcome: vi.fn(() => ({ status: "completed", result: null })),
      } as unknown as DurablePrpControlPlane,
    });
    const newRegistration = await registerRunnerPrpAuthority({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: newRunId,
      authority: {
        queueCommand: newQueueCommand,
        commandOutcome: vi.fn(() => ({ status: "completed", result: null })),
      } as unknown as DurablePrpControlPlane,
    });

    expect(
      (await queueLiveRunnerPrpCommand({
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        type: "session.goal.get",
      })),
    ).toMatchObject({ runId: newRunId, commandId: "new-command" });
    expect(oldQueueCommand).not.toHaveBeenCalled();
    expect(newQueueCommand).toHaveBeenCalledOnce();

    await oldRegistration.release();
    expect(
      (await queueLiveRunnerPrpCommand({
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        type: "session.goal.get",
      })),
    ).toMatchObject({ runId: newRunId, commandId: "new-command" });
    expect(newQueueCommand).toHaveBeenCalledTimes(2);

    await newRegistration.release();
    expect(
      (await queueLiveRunnerPrpCommand({
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        type: "session.goal.get",
      })),
    ).toBeNull();
    server.close();
  });

  it("queues one company-bound, idempotent runtime request resolution", async () => {
    const server = createServer();
    setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3213" });
    const receipts = new Map<string, string>();
    const queueCommand = vi.fn(async (_type, payload, id) => {
      const encoded = JSON.stringify(payload);
      if (receipts.has(id) && receipts.get(id) !== encoded) {
        throw new Error("Durable PRP command replay conflicts with persisted state.");
      }
      receipts.set(id, encoded);
      return { commandId: "command-resolution-1" };
    });
    const runId = "00000000-0000-4000-8000-000000000780";
    const registration = await registerRunnerPrpAuthority({
      companyId: "company-1",
      runId,
      authority: {
        queueCommand,
        store: { state: { identity: { runId } } },
      } as unknown as DurablePrpControlPlane,
    });
    const input = {
      companyId: "company-1",
      runId,
      pendingRequest: {
        companyId: "company-1",
        runId,
        requestId: "request-1",
        requestKind: "command_approval" as const,
        turnId: "turn-1",
        resolverPolicy: "instance_admin" as const,
      },
      actor: {
        type: "user" as const,
        userId: "instance-admin",
        isInstanceAdmin: true,
      },
      resolution: { action: "accept" as const },
    };

    expect(await Promise.all([
      queueRunnerPrpRuntimeRequestResolution(input),
      queueRunnerPrpRuntimeRequestResolution(input),
    ])).toEqual([{ commandId: "command-resolution-1" }, { commandId: "command-resolution-1" }]);
    expect(queueCommand).toHaveBeenCalledTimes(1);
    expect(queueCommand).toHaveBeenCalledWith(
      "request.resolve",
      {
        requestId: "request-1",
        requestKind: "command_approval",
        turnId: "turn-1",
        resolution: { action: "accept" },
        resolutionActor: {
          type: "user",
          userId: "instance-admin",
          isInstanceAdmin: true,
        },
      },
      expect.stringMatching(/^runtime_resolution_[a-f0-9]{64}$/),
      true,
    );

    await expect(async () =>
      (await queueRunnerPrpRuntimeRequestResolution({
        ...input,
        companyId: "company-2",
      })),
    ).rejects.toThrowError("runner_prp_authority_not_active");
    await expect(async () =>
      (await queueRunnerPrpRuntimeRequestResolution({
        ...input,
        resolution: { action: "decline" },
      })),
    ).rejects.toThrowError(RunnerPrpRuntimeRequestResolutionError);

    await expect(async () =>
      (await queueRunnerPrpRuntimeRequestResolution({
        ...input,
        actor: {
          type: "user",
          userId: "ordinary-member",
          isInstanceAdmin: false,
        },
      })),
    ).rejects.toThrowError("native_runtime_request_resolver_denied");
    for (const pendingRequest of [
      { ...input.pendingRequest, companyId: "company-2" },
      { ...input.pendingRequest, runId: "00000000-0000-4000-8000-000000000783" },
    ]) {
      await expect(async () => (await queueRunnerPrpRuntimeRequestResolution({
        ...input,
        pendingRequest,
      }))).rejects.toThrowError("runner_prp_authority_not_active");
    }
    expect(queueCommand).toHaveBeenCalledTimes(2);
    expect(await queueRunnerPrpRuntimeRequestResolution(input)).toEqual({ commandId: "command-resolution-1" });
    expect(receipts.size).toBe(1);

    await registration.release();
    await expect(async () => (await queueRunnerPrpRuntimeRequestResolution(input))).rejects.toThrowError(
      "runner_prp_authority_not_active",
    );
    server.close();
  });

  it.each([false, true])(
    "rejects a retained old route after real authority rotation (cached=%s)",
    async (cached) => {
      const directory = mkdtempSync(join(tmpdir(), "runner-route-rotation-"));
      const server = createServer();
      setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3214" });
      const identity = {
        runnerInstanceId: "runner-route-test",
        environmentLeaseId: "environment-route-test",
        normalizedSessionId: "session-route-test",
        runId: "00000000-0000-4000-8000-000000000781",
        turnId: "turn-route-old",
        itemId: "item-route-old",
      };
      const nextIdentity = {
        ...identity,
        runId: "00000000-0000-4000-8000-000000000782",
        turnId: "turn-route-new",
        itemId: "item-route-new",
      };
      try {
        const authority = new DurablePrpControlPlane({
          stateDirectory: directory,
          identity,
          expectedRunnerVersion: "0.3.0",
          expectedRunnerDigest: `sha256:${"a".repeat(64)}`,
        });
        const oldRoute = await registerRunnerPrpAuthority({
          companyId: "company-1",
          runId: identity.runId,
          authority,
        });
        // Warm attach registers the next route before rotating the same core.
        const nextRoute = await registerRunnerPrpAuthority({
          companyId: "company-1",
          runId: nextIdentity.runId,
          authority,
        });
        const input = {
          companyId: "company-1",
          runId: identity.runId,
          pendingRequest: {
            companyId: "company-1",
            runId: identity.runId,
            requestId: "request-old",
            requestKind: "command_approval" as const,
            turnId: "provider-turn-old",
            resolverPolicy: "instance_admin" as const,
          },
          actor: {
            type: "user" as const,
            userId: "instance-admin",
            isInstanceAdmin: true,
          },
          resolution: { action: "accept" as const },
        };
        const nextInput = {
          ...input,
          runId: nextIdentity.runId,
          pendingRequest: {
            ...input.pendingRequest,
            runId: nextIdentity.runId,
            requestId: "request-new",
            turnId: "provider-turn-new",
          },
        };
        // Registering the future URL cannot dispatch into the old authority.
        await expect(async () =>
          (await queueRunnerPrpRuntimeRequestResolution(nextInput)),
        ).rejects.toThrowError(
          "runner_prp_authority_not_active",
        );
        expect(authority.store.state.commands).toEqual([]);
        if (cached) {
          const queued = (await queueRunnerPrpRuntimeRequestResolution(input));
          const command = authority.store.state.commands.find(
            (candidate) => candidate.commandId === queued.commandId,
          )!;
          // Represent a completed old response before the warm attachment.
          command.status = "completed";
          command.result = { status: "completed" };
        }
        (await authority.rotateRunIdentity(nextIdentity));
        expect(authority.store.state.identity).toEqual(nextIdentity);
        expect(authority.store.state.commands).toEqual([]);
        const statePath = join(directory, "control-plane-state.json");
        const before = readFileSync(statePath, "utf8");

        await expect(async () => (await queueRunnerPrpRuntimeRequestResolution(input))).rejects.toThrowError(
          "runner_prp_authority_not_active",
        );
        expect(authority.store.state.commands).toEqual([]);
        expect(readFileSync(statePath, "utf8")).toBe(before);

        const next = (await queueRunnerPrpRuntimeRequestResolution(nextInput));
        expect((await queueRunnerPrpRuntimeRequestResolution(nextInput))).toEqual(next);
        expect(authority.store.state.commands).toHaveLength(1);
        expect(authority.store.state.commands[0]).toMatchObject({
          commandId: next.commandId,
          type: "request.resolve",
          payload: { requestId: "request-new", turnId: "provider-turn-new" },
        });
        await oldRoute.release();
        expect(
          runnerPrpWebSocketInternals.activeRegistration({
            companyId: "company-1",
            runId: nextIdentity.runId,
          }),
        ).toBe(true);
        await nextRoute.release();
      } finally {
        server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
