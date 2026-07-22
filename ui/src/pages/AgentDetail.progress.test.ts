import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { queryKeys } from "../lib/queryKeys";
import {
  buildHeartbeatProgressLogLine,
  heartbeatProgressLogLineKey,
  syncAgentRouteAfterRename,
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

describe("syncAgentRouteAfterRename", () => {
  it("replaces stale agent routes after a rename changes the URL key", () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    queryClient.setQueryData(queryKeys.agents.detail("old-agent"), { id: "agent-1" });
    queryClient.setQueryData(queryKeys.agents.detail("renamed-agent"), { id: "agent-1" });

    const redirected = syncAgentRouteAfterRename(
      queryClient,
      navigate,
      { id: "agent-1", name: "Old Agent", urlKey: "old-agent" },
      { id: "agent-1", name: "Renamed Agent", urlKey: "renamed-agent" },
      "configuration",
    );

    expect(redirected).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/agents/renamed-agent/configuration", { replace: true });
    expect(queryClient.getQueryData(queryKeys.agents.detail("old-agent"))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.agents.detail("renamed-agent"))).toEqual({ id: "agent-1" });
  });

  it("does not redirect when the canonical route ref stays the same", () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    queryClient.setQueryData(queryKeys.agents.detail("same-agent"), { id: "agent-1" });

    const redirected = syncAgentRouteAfterRename(
      queryClient,
      navigate,
      { id: "agent-1", name: "Same Agent", urlKey: "same-agent" },
      { id: "agent-1", name: "Same Agent", urlKey: "same-agent" },
      "configuration",
    );

    expect(redirected).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.agents.detail("same-agent"))).toEqual({ id: "agent-1" });
  });
});
