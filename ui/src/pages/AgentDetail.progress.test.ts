import { describe, expect, it } from "vitest";

import {
  buildHeartbeatProgressLogLine,
  heartbeatProgressLogLineKey,
} from "./AgentDetail";

describe("buildHeartbeatProgressLogLine", () => {
  it("renders progress messages with phase prefixes as system log lines", () => {
    expect(
      buildHeartbeatProgressLogLine(
        {
          message: "Syncing issue history",
          phase: "workspace",
          updatedAt: "2026-07-04T05:00:00.000Z",
        },
        "2026-07-04T04:59:00.000Z",
      ),
    ).toEqual({
      ts: "2026-07-04T05:00:00.000Z",
      stream: "system",
      chunk: "[workspace] Syncing issue history",
    });
  });

  it("renders progress messages without phases using the live event timestamp", () => {
    expect(
      buildHeartbeatProgressLogLine(
        { message: "Preparing workspace" },
        "2026-07-04T05:01:00.000Z",
      ),
    ).toEqual({
      ts: "2026-07-04T05:01:00.000Z",
      stream: "system",
      chunk: "Preparing workspace",
    });
  });

  it("ignores empty progress messages", () => {
    expect(
      buildHeartbeatProgressLogLine(
        { message: "   ", phase: "workspace" },
        "2026-07-04T05:02:00.000Z",
      ),
    ).toBeNull();
  });
});

describe("heartbeatProgressLogLineKey", () => {
  it("uses the rendered log line fields as the replay key", () => {
    const line = {
      ts: "2026-07-04T05:03:00.000Z",
      stream: "system" as const,
      chunk: "[workspace] Syncing issue history",
    };

    expect(heartbeatProgressLogLineKey(line)).toBe(
      "2026-07-04T05:03:00.000Z\u0000system\u0000[workspace] Syncing issue history",
    );
  });
});
