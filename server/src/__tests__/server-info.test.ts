import { describe, expect, it } from "vitest";
import { createServerInfoSnapshot } from "../server-info.js";

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
    });

    expect(snapshot).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: true,
        fullSha: "0123456789abcdef0123456789abcdef01234567",
        shortSha: "0123456",
        subject: "Add server info debug view",
        committedAt: "2026-06-26T00:00:00.000Z",
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
