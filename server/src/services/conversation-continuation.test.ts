import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  UNVERIFIED_PROCESS_IDENTITY_GRACE_MS,
  getConversationOwnershipBlocker,
} from "./conversation-continuation.js";

/** The candidate query is raw SQL; these tests drive the decision loop instead. */
function candidateDb(candidates: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => candidates,
        }),
      }),
    }),
  } as unknown as Db;
}

const RECORDED_START = new Date("2026-09-28T23:45:54.287Z");
const NOW = Date.parse("2026-09-29T01:00:00.000Z");

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      id: "run-1",
      agentId: "agent-1",
      processPid: 4242,
      processGroupId: null,
      processStartedAt: RECORDED_START,
      finishedAt: new Date(NOW - 30 * 60_000),
      updatedAt: new Date(NOW - 30 * 60_000),
      createdAt: new Date(NOW - 60 * 60_000),
      ...overrides,
    },
    cleanupPendingLease: false,
    unreleasedLease: false,
  };
}

function probe(value: string | null | (() => never)) {
  return typeof value === "function"
    ? async () => value()
    : async () => value;
}

function read(
  candidates: unknown[],
  options: {
    alive?: boolean;
    observed?: string | null | (() => never);
  } = {},
) {
  return getConversationOwnershipBlocker(candidateDb(candidates), "company-1", "issue-1", {
    isProcessAlive: () => options.alive ?? true,
    readProcessStartedAt: probe(options.observed === undefined ? RECORDED_START.toISOString() : options.observed),
    now: () => NOW,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getConversationOwnershipBlocker", () => {
  it("holds while the live PID's recorded start time still matches", async () => {
    await expect(read([candidate()])).resolves.toMatchObject({
      runId: "run-1",
      agentId: "agent-1",
      cause: "execution_owner_active",
    });
  });

  it("does not mark a matched identity as unverified", async () => {
    const blocker = await read([candidate()]);
    expect(blocker).not.toBeNull();
    expect(blocker!.identityUnverified).toBeUndefined();
    expect(blocker!.nextAction).not.toContain("could not be read");
  });

  it("releases a recycled PID whose observed start time differs", async () => {
    await expect(
      read([candidate()], { observed: "2026-09-28T23:56:16.093Z" }),
    ).resolves.toBeNull();
  });

  it("releases when the PID is gone", async () => {
    await expect(read([candidate()], { alive: false })).resolves.toBeNull();
  });

  it("releases an unreadable identity once the run has been terminal past the grace", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const longTerminal = candidate({
      finishedAt: new Date(NOW - UNVERIFIED_PROCESS_IDENTITY_GRACE_MS - 60_000),
    });
    await expect(
      read([longTerminal], { observed: () => { throw new Error("probe unavailable"); } }),
    ).resolves.toBeNull();
    // The release is otherwise invisible outside this function.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("releasing unverifiable execution hold"));
  });

  it("still holds inside the grace but reports the hold as unverified", async () => {
    const blocker = await read([candidate()], {
      observed: () => { throw new Error("probe unavailable"); },
    });
    expect(blocker).toMatchObject({ cause: "execution_owner_active", identityUnverified: true });
    expect(blocker!.nextAction).toContain("could not be read");
  });

  it("bounds the grace by the terminal time, not by the run's age", async () => {
    // Created long ago, but only just reached its terminal state: the hold has
    // not yet outlived the grace, so the ambiguity stays conservative.
    const longRun = candidate({
      createdAt: new Date(NOW - 40 * 60 * 60_000),
      finishedAt: new Date(NOW - 5 * 60_000),
      updatedAt: new Date(NOW - 5 * 60_000),
    });
    await expect(read([longRun], { observed: null })).resolves.toMatchObject({
      identityUnverified: true,
    });
  });

  it("treats a null probe result the same as an unreadable one", async () => {
    const longTerminal = candidate({
      finishedAt: new Date(NOW - UNVERIFIED_PROCESS_IDENTITY_GRACE_MS - 1),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(read([longTerminal], { observed: null })).resolves.toBeNull();
  });

  it("keeps an unreleased environment lease blocking inside the terminal grace", async () => {
    await expect(
      read([{ run: candidate().run, unreleasedLease: true }], { alive: false }),
    ).resolves.toMatchObject({
      cause: "execution_owner_active",
      nextAction: expect.stringContaining("environment lease"),
    });
  });

  it("releases an unreleased environment lease once the run has been terminal past the grace", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const longTerminal = {
      run: candidate({
        finishedAt: new Date(NOW - UNVERIFIED_PROCESS_IDENTITY_GRACE_MS - 60_000),
      }).run,
      unreleasedLease: true,
    };
    await expect(read([longTerminal], { alive: false })).resolves.toBeNull();
    // The release is otherwise invisible outside this function.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("releasing unreleased environment lease hold"));
  });

  it("bounds the lease hold by the terminal time, not by the run's age", async () => {
    const longRun = {
      run: candidate({
        createdAt: new Date(NOW - 40 * 60 * 60_000),
        finishedAt: new Date(NOW - 5 * 60_000),
        updatedAt: new Date(NOW - 5 * 60_000),
      }).run,
      unreleasedLease: true,
    };
    await expect(read([longRun], { alive: false })).resolves.toMatchObject({
      cause: "execution_owner_active",
      nextAction: expect.stringContaining("environment lease"),
    });
  });

  it("keeps a cleanup-pending lease blocking past the terminal grace", async () => {
    const longTerminal = {
      run: candidate({
        finishedAt: new Date(NOW - UNVERIFIED_PROCESS_IDENTITY_GRACE_MS - 60_000),
      }).run,
      cleanupPendingLease: true,
      unreleasedLease: false,
    };
    await expect(read([longTerminal], { alive: false })).resolves.toMatchObject({
      cause: "execution_owner_active",
      nextAction: expect.stringContaining("environment lease"),
    });
  });

  it("releases when every candidate is recycled", async () => {
    await expect(
      read([candidate(), candidate({ id: "run-2" })], {
        observed: "2026-09-28T23:56:16.093Z",
      }),
    ).resolves.toBeNull();
  });
});
