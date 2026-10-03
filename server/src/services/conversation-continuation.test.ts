import { describe, expect, it, vi } from "vitest";
import { persistedConversationProcessLiveness } from "./conversation-continuation.js";

describe("persisted conversation process ownership", () => {
  const stored = {
    processPid: 49773,
    processGroupId: 49773,
    processStartedAt: new Date("2026-09-30T06:30:00.000Z"),
  };

  it("does not hold a terminal run when its PID was reused and its group is gone", async () => {
    const isAlive = vi.fn((pid: number) => pid > 0);
    const startedAt = vi.fn().mockResolvedValue("2026-09-30T10:00:00.000Z");
    await expect(persistedConversationProcessLiveness(stored, { isAlive, startedAt }))
      .resolves.toEqual({ pidAlive: false, groupAlive: false });
    expect(isAlive).toHaveBeenCalledWith(49773);
    expect(isAlive).toHaveBeenCalledWith(-49773);
  });

  it("retains the hold when process identity cannot be read", async () => {
    await expect(persistedConversationProcessLiveness(stored, {
      isAlive: () => true,
      startedAt: async () => { throw new Error("unreadable"); },
    })).resolves.toEqual({ pidAlive: true, groupAlive: true });
  });

  it("keeps a live group after its leader PID is reused", async () => {
    await expect(persistedConversationProcessLiveness(stored, {
      isAlive: () => true,
      startedAt: async () => "2026-09-30T10:00:00.000Z",
      groupMembers: async () => [
        { pid: 49773, startedAt: "2026-09-30T10:00:00.000Z" },
        { pid: 49774, startedAt: "2026-09-30T06:30:01.000Z" },
      ],
    })).resolves.toEqual({ pidAlive: false, groupAlive: true });
  });

  it("releases a reused process group only when all members belong to its new leader", async () => {
    await expect(persistedConversationProcessLiveness(stored, {
      isAlive: () => true,
      startedAt: async () => "2026-09-30T10:00:00.000Z",
      groupMembers: async () => [
        { pid: 49773, startedAt: "2026-09-30T10:00:00.000Z" },
        { pid: 49775, startedAt: "2026-09-30T10:00:01.000Z" },
      ],
    })).resolves.toEqual({ pidAlive: false, groupAlive: false });
  });

  it("keeps a live PID when its recorded timestamp differs by less than five seconds", async () => {
    await expect(persistedConversationProcessLiveness(stored, {
      isAlive: () => true,
      startedAt: async () => "2026-09-30T06:30:03.000Z",
    })).resolves.toEqual({ pidAlive: true, groupAlive: true });
  });

  it("releases a rapidly reused PID when it started after the terminal run ended", async () => {
    await expect(persistedConversationProcessLiveness({
      ...stored,
      finishedAt: new Date("2026-09-30T06:30:01.000Z"),
    }, {
      isAlive: () => true,
      startedAt: async () => "2026-09-30T06:30:03.000Z",
      groupMembers: async () => [{ pid: 49773, startedAt: "2026-09-30T06:30:03.000Z" }],
    })).resolves.toEqual({ pidAlive: false, groupAlive: false });
  });
});
