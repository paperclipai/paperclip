import { afterEach, describe, expect, it, vi } from "vitest";
import { chatActions, type Db } from "@paperclipai/db";
import { chatChannelService, type ChatChannelService, type ChatChannelServiceOptions } from "../services/chat-channels.js";
import { authorizeCommittedChatResponse, CommittedChatResponseAuthorizationError } from "../services/durable-chat-wakeup.js";

const services = new Set<ChatChannelService>();
afterEach(async () => {
  for (const service of services) await service.shutdown();
  services.clear();
});

function createService(db: Db) {
  const wakeup = vi.fn().mockResolvedValue(undefined);
  const runtimeShutdown = vi.fn().mockResolvedValue(undefined);
  const service = chatChannelService(db, {
    heartbeat: { wakeup },
    runtime: { shutdown: runtimeShutdown } as unknown as ChatChannelServiceOptions["runtime"],
  });
  services.add(service);
  return { service, wakeup, runtimeShutdown };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("failed chat retry service lifetime", () => {
  it("shares an in-flight retry and observes shutdown after its candidate read", async () => {
    const candidate = deferred<unknown[]>();
    const reads = vi.fn((table: unknown) => table === chatActions ? candidate.promise : Promise.resolve([]));
    const update = vi.fn(() => { throw new Error("A shutdown retry must not claim work"); });
    const db = {
      select: () => ({ from: (table: unknown) => ({ where: () => reads(table) }) }),
      update,
    } as unknown as Db;
    const { service, wakeup, runtimeShutdown } = createService(db);
    const first = service.processFailedChatRunRetry("retry-action");
    const second = service.processFailedChatRunRetry("retry-action");
    expect(second).toBe(first);
    expect(reads).toHaveBeenCalledTimes(1);
    const shutdown = service.shutdown();
    expect(runtimeShutdown).not.toHaveBeenCalled();
    candidate.resolve([{
      id: "retry-action", companyId: "company", status: "issued",
      payload: { issueId: "issue" }, result: {}, updatedAt: new Date(0),
    }]);
    await expect(first).resolves.toMatchObject({ actionId: "retry-action", status: "queued" });
    await shutdown;
    services.delete(service);
    expect(update).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
    expect(runtimeShutdown).toHaveBeenCalledTimes(1);
  });

  it("releases a rejected in-flight retry so a later attempt can read again", async () => {
    const where = vi.fn().mockResolvedValue([]);
    const db = { select: () => ({ from: () => ({ where }) }) } as unknown as Db;
    const { service } = createService(db);
    const first = service.processFailedChatRunRetry("missing-action");
    await expect(first).rejects.toMatchObject({ status: 404 });
    const second = service.processFailedChatRunRetry("missing-action");
    expect(second).not.toBe(first);
    await expect(second).rejects.toMatchObject({ status: 404 });
    expect(where).toHaveBeenCalledTimes(2);
  });

  it("does not unregister a replacement service's committed-response authority", async () => {
    const db = {} as Db;
    const first = createService(db).service;
    const replacement = createService(db).service;
    await first.shutdown();
    services.delete(first);
    const readFailure = new Error("replacement authority reached current source reads");
    const tx = { select: () => { throw readFailure; } } as unknown as Db;
    const input = { companyId: "company", issueId: "issue", agentId: "agent", runId: "run", resultId: "result" };
    await expect(authorizeCommittedChatResponse(db, tx, input)).rejects.toBe(readFailure);
    await replacement.shutdown();
    services.delete(replacement);
    await expect(authorizeCommittedChatResponse(db, tx, input)).rejects.toBeInstanceOf(CommittedChatResponseAuthorizationError);
  });
});
