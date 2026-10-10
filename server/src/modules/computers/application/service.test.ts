import { describe, it, expect, vi } from "vitest";
import { createComputerService } from "./service.js";
import type { ComputerBackend, ComputerRepository } from "./ports.js";
import { ComputerError, type ComputerRecord } from "../domain/ledger.js";

function fixture() {
  let record: ComputerRecord | undefined;
  let clock = new Date("2026-10-10T12:00:00Z");
  let state = "ready";
  let stopStatus = "pending";
  const repository: ComputerRepository = {
    create: async (value) => {
      record = structuredClone(value);
    },
    get: async (scope) => {
      if (
        !record ||
        record.companyId !== scope.companyId ||
        record.environmentId !== scope.environmentId
      )
        throw new ComputerError("not_found", "missing");
      return structuredClone(record);
    },
    update: async (scope, fn) => {
      const next = await repository.get(scope);
      const result = fn(next);
      record = next;
      return result;
    },
    all: async () => (record ? [structuredClone(record)] : []),
    runState: vi.fn(async () => "active" as const),
  };
  const backend: ComputerBackend = {
    inspect: vi.fn(async () => ({ state, snapshots: true, stop: null })),
    ready: vi.fn(async () => {
      state = "ready";
    }),
    claim: vi.fn(async () => {}),
    advance: vi.fn(async () => {}),
    runner: vi.fn(async () => ({ execute: vi.fn() })),
    launch: vi.fn(async (_record, owner) => ({
      ...owner.process!,
      bootId: "boot",
    })),
    inspectProcess: vi.fn(async (_record, owner) => ({
      running: true,
      claim: owner.process,
    })),
    retire: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ id: "stop_1", status: stopStatus })),
    stopStatus: vi.fn(async () => ({ id: "stop_1", status: stopStatus })),
    renew: vi.fn(async () => {}),
    desktop: vi.fn(async () => ({
      viewerUrl: "https://test.on.boat.dev/#credential",
      expiresAt: new Date(clock.getTime() + 540_000).toISOString(),
    })),
    ingress: vi.fn(async () => ({
      url: "wss://test.on.boat.dev/",
      secretHeaders: { Cookie: "private" },
    })),
    preview: vi.fn(async () => ({
      url: "https://test.on.boat.dev/?_token=private",
    })),
    remote: vi.fn(async () => ({
      remoteCwd: "/home/user/paperclip/company/projects/project/checkout",
    })),
  };
  const service = createComputerService(repository, backend, () => clock);
  const scope = { companyId: "company", environmentId: "environment" };
  const attach = () =>
    service.attach({
      ...scope,
      sandboxId: "bx_fixture",
      apiKeySecretRef: { type: "secret_ref", secretId: "secret" },
    });
  const admit = (agentId = "agent", sessionKey = "session") =>
    service.admit({
      ...scope,
      agentId,
      sessionKey,
      runId: "run",
      idleTimeoutMs: 60_000,
    });
  return {
    service,
    backend,
    scope,
    attach,
    admit,
    repository,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    completeStop: () => {
      stopStatus = "completed";
      state = "stopped";
    },
  };
}
describe("computer ownership", () => {
  it("reuses warm process identity and port while fencing stale callbacks", async () => {
    const f = fixture();
    await f.attach();
    const first = await f.admit();
    const claim = await first.launch({ command: "runnerd" });
    await f.service.retainWarm({
      ...f.scope,
      owner: first.owner,
      idleTimeoutMs: 60_000,
    });
    const next = await f.admit();
    expect(next.owner.generation).toBe(first.owner.generation + 1);
    expect(next.listenerPort).toBe(first.listenerPort);
    expect((await next.inspectProcess()).claim?.nonce).toBe(claim.nonce);
    await f.service.retire({ ...f.scope, owner: first.owner });
    expect(f.backend.retire).not.toHaveBeenCalled();
    await f.service.retire({ ...f.scope, owner: next.owner });
    expect(f.backend.retire).toHaveBeenCalledOnce();
  });
  it("does not suspend another agent and fences admission until provider stop completes", async () => {
    const f = fixture();
    await f.attach();
    const a = await f.admit("agent-a", "a");
    const b = await f.admit("agent-b", "b");
    expect(a.listenerPort).not.toBe(b.listenerPort);
    expect(a.agentHome).not.toBe(b.agentHome);
    await f.service.retire({ ...f.scope, owner: a.owner });
    await f.service.reconcile();
    expect(f.backend.stop).not.toHaveBeenCalled();
    await f.service.retire({ ...f.scope, owner: b.owner });
    await f.service.reconcile();
    expect(f.backend.stop).toHaveBeenCalledOnce();
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
    await f.service.reconcile();
    expect(f.backend.stopStatus).toHaveBeenCalledOnce();
    f.completeStop();
    await f.service.reconcile();
    await expect(f.admit()).resolves.toHaveProperty("owner");
  });
  it("retains a failed stop intent and retries the same idempotent operation", async () => {
    const f = fixture();
    await f.attach();
    vi.mocked(f.backend.stop).mockRejectedValueOnce(
      new Error("network response lost"),
    );
    await expect(f.service.reconcile()).rejects.toBeInstanceOf(AggregateError);
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
    await f.service.reconcile();
    expect(f.backend.stop).toHaveBeenCalledTimes(2);
    expect(
      (await f.repository.get(f.scope)).ledger.action?.providerStopId,
    ).toBe("stop_1");
  });
  it("viewer renewals cannot extend the absolute warm deadline or use another user", async () => {
    const f = fixture();
    await f.attach();
    const viewer = await f.service.connect({
      ...f.scope,
      userId: "alice",
      idleTimeoutMs: 10_000,
    });
    expect(viewer.expiresAt).toBe("2026-10-10T12:00:10.000Z");
    await expect(
      f.service.renewViewer({ ...f.scope, owner: viewer.owner, userId: "bob" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.advance(9_000);
    expect(
      (
        await f.service.renewViewer({
          ...f.scope,
          owner: viewer.owner,
          userId: "alice",
        })
      ).expiresAt,
    ).toBe(viewer.expiresAt);
    f.advance(1_001);
    await expect(
      f.service.renewViewer({
        ...f.scope,
        owner: viewer.owner,
        userId: "alice",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.service.reconcile();
    expect(f.backend.stop).toHaveBeenCalledOnce();
  });
  it("a failed exact-process retirement keeps the machine held", async () => {
    const f = fixture();
    await f.attach();
    const a = await f.admit();
    vi.mocked(f.backend.retire).mockRejectedValue(new Error("not confirmed"));
    await expect(
      f.service.retire({ ...f.scope, owner: a.owner }),
    ).rejects.toThrow("not confirmed");
    await expect(f.service.reconcile()).rejects.toBeInstanceOf(AggregateError);
    expect(f.backend.stop).not.toHaveBeenCalled();
  });
  it("keeps snapshot and attachment proof when detached", async () => {
    const f = fixture();
    await f.attach();
    await f.admit();
    await f.service.detach(f.scope);
    expect((await f.repository.get(f.scope)).ledger.status).toBe("detaching");
    f.completeStop();
    await f.service.reconcile();
    expect((await f.repository.get(f.scope)).ledger.status).toBe("detached");
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
  });
  it("rejects cross company scopes before provider access", async () => {
    const f = fixture();
    await f.attach();
    vi.mocked(f.backend.inspect).mockClear();
    await expect(
      f.service.inspect({ ...f.scope, companyId: "another" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.backend.inspect).not.toHaveBeenCalled();
  });
  it("keeps process capabilities across attempt generations only for the exact same process", async () => {
    const f = fixture();
    await f.attach();
    const first = await f.admit();
    await first.launch({ command: "runnerd" });
    await f.service.retainWarm({
      ...f.scope,
      owner: first.owner,
      idleTimeoutMs: 60_000,
    });
    await f.admit();
    await expect(first.ingress()).rejects.toMatchObject({ code: "conflict" });
    await expect(first.process.ingress()).resolves.toHaveProperty("url");
    await f.repository.update(f.scope, (record) => {
      record.ledger.owners[0]!.process!.nonce = "replacement-process";
    });
    await expect(first.process.ingress()).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it.each(["terminal", "missing"] as const)(
    "retires an orphan active owner with a %s run after admission grace",
    async (state) => {
      const f = fixture();
      await f.attach();
      await f.admit();
      vi.mocked(f.repository.runState).mockResolvedValue(state);
      f.advance(119_000);
      await f.service.reconcile();
      expect(f.backend.retire).not.toHaveBeenCalled();
      f.advance(1_001);
      await f.service.reconcile();
      expect(f.backend.retire).toHaveBeenCalledOnce();
      expect(f.backend.stop).toHaveBeenCalledOnce();
    },
  );
  it("preserves recoverable running owners and gives completed warm owners their idle interval", async () => {
    const f = fixture();
    await f.attach();
    const binding = await f.admit();
    f.advance(180_000);
    await f.service.reconcile();
    expect(f.backend.retire).not.toHaveBeenCalled();
    await f.service.retainWarm({
      ...f.scope,
      owner: binding.owner,
      idleTimeoutMs: 60_000,
    });
    vi.mocked(f.repository.runState).mockResolvedValue("terminal");
    await f.service.reconcile();
    expect(f.backend.retire).not.toHaveBeenCalled();
    f.advance(60_001);
    await f.service.reconcile();
    expect(f.backend.retire).toHaveBeenCalledOnce();
  });
});
