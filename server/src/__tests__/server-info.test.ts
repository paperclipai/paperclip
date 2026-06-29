import { beforeEach, describe, expect, it } from "vitest";
import {
  createServerInfoSnapshot,
  getServerInfoSnapshot,
  resetServerInfoCacheForTests,
} from "../server-info.js";

function gitCommandFor(shortSha: string, subject: string): () => string {
  return () =>
    [shortSha.padEnd(40, "0"), shortSha, subject, "2026-06-25T17:00:00-07:00"].join("\n");
}

describe("server info snapshot", () => {
  it("captures process start time and git metadata", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitStatusCommand: () => "",
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: true,
        fullSha: "0123456789abcdef0123456789abcdef01234567",
        shortSha: "0123456",
        subject: "Add server info debug view",
        committedAt: "2026-06-26T00:00:00.000Z",
        localChanges: {
          available: true,
          hasLocalChanges: false,
          stagedFileCount: 0,
          unstagedFileCount: 0,
          untrackedFileCount: 0,
        },
      },
    });
  });

  it("summarizes local checkout changes without exposing file paths", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitStatusCommand: () =>
        [
          "M  packages/shared/src/types/server-info.ts",
          " M ui/src/components/SidebarServerInfo.tsx",
          "MM server/src/server-info.ts",
          "?? server/src/__tests__/server-info.test.ts",
        ].join("\n"),
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      localChanges: {
        available: true,
        hasLocalChanges: true,
        stagedFileCount: 2,
        unstagedFileCount: 2,
        untrackedFileCount: 1,
      },
    });
  });

  it("keeps commit metadata available when git status is unavailable", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () =>
        [
          "0123456789abcdef0123456789abcdef01234567",
          "0123456",
          "Add server info debug view",
          "2026-06-25T17:00:00-07:00",
        ].join("\n"),
      gitStatusCommand: () => {
        throw new Error("status unavailable");
      },
    });

    expect(snapshot.git).toMatchObject({
      available: true,
      localChanges: {
        available: false,
        unavailableReason: "git_status_unavailable",
      },
    });
  });

  it("uses sanitized fallback metadata when git is unavailable", () => {
    const snapshot = createServerInfoSnapshot({
      now: new Date("2026-06-26T00:00:00.000Z"),
      gitCommand: () => {
        throw new Error("fatal: not a git repository");
      },
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
    });
  });
});

describe("getServerInfoSnapshot", () => {
  beforeEach(() => {
    resetServerInfoCacheForTests();
  });

  it("re-reads the running commit after the cache TTL expires", () => {
    const first = getServerInfoSnapshot({
      now: 0,
      gitCommand: gitCommandFor("aaaaaaa", "First boot"),
    });
    expect(first.git).toMatchObject({ shortSha: "aaaaaaa", subject: "First boot" });

    // Within the TTL window the cached commit is reused.
    const cached = getServerInfoSnapshot({
      now: 1000,
      gitCommand: gitCommandFor("bbbbbbb", "After restart"),
    });
    expect(cached.git).toMatchObject({ shortSha: "aaaaaaa", subject: "First boot" });

    // Past the TTL the new HEAD is picked up without a process restart.
    const refreshed = getServerInfoSnapshot({
      now: 3000,
      gitCommand: gitCommandFor("bbbbbbb", "After restart"),
    });
    expect(refreshed.git).toMatchObject({ shortSha: "bbbbbbb", subject: "After restart" });
  });

  it("keeps processStartedAt stable across refreshes", () => {
    const first = getServerInfoSnapshot({ now: 0, gitCommand: gitCommandFor("aaaaaaa", "a") });
    const second = getServerInfoSnapshot({ now: 5000, gitCommand: gitCommandFor("bbbbbbb", "b") });
    expect(second.processStartedAt).toBe(first.processStartedAt);
  });
});
