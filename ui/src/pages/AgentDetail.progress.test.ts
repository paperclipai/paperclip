import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { queryKeys } from "../lib/queryKeys";
import {
  AGENT_DETAIL_TABS,
  DISCARD_AGENT_CONFIG_CHANGES_MESSAGE,
  agentConfigHistoryRestoreDelta,
  buildHeartbeatProgressLogLine,
  confirmAgentConfigNavigation,
  heartbeatProgressLogLineKey,
  parseAgentDetailView,
  restoreAgentConfigHistoryEntry,
  runDetailRefetchIntervalMs,
  shouldPollRunShellLog,
  syncAgentRouteAfterRename,
} from "./AgentDetail";

describe("agent detail tabs", () => {
  it("exposes Secrets as its own route-backed tab", () => {
    expect(AGENT_DETAIL_TABS.map((tab) => tab.label)).toContain("Secrets");
    expect(parseAgentDetailView("secrets")).toBe("secrets");
  });

  it("requires confirmation before navigation can discard unsaved configuration", () => {
    const confirm = vi.fn().mockReturnValue(false);

    expect(confirmAgentConfigNavigation(true, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(DISCARD_AGENT_CONFIG_CHANGES_MESSAGE);

    confirm.mockReturnValue(true);
    expect(confirmAgentConfigNavigation(true, confirm)).toBe(true);
    expect(confirmAgentConfigNavigation(false, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("restores the prior history entry when Back or Forward navigation is rejected", () => {
    expect(agentConfigHistoryRestoreDelta(4, 2)).toBe(2);
    expect(agentConfigHistoryRestoreDelta(2, 4)).toBe(-2);
    expect(agentConfigHistoryRestoreDelta(2, 2)).toBeNull();
    expect(agentConfigHistoryRestoreDelta(undefined, 1)).toBeNull();
  });

  it("restores the guarded URL when React Router history indexes are unavailable", () => {
    const history = {
      go: vi.fn(),
      pushState: vi.fn(),
    };
    const currentState = { key: "agent-config" };

    expect(restoreAgentConfigHistoryEntry(history, {
      index: undefined,
      state: currentState,
      url: "https://paperclip.test/agents/eng/secrets",
    }, undefined)).toBe(false);
    expect(history.pushState).toHaveBeenCalledWith(
      currentState,
      "",
      "https://paperclip.test/agents/eng/secrets",
    );
    expect(history.go).not.toHaveBeenCalled();
  });
});

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

describe("shouldPollRunShellLog", () => {
  it("polls only after a queued run has started running", () => {
    expect(shouldPollRunShellLog("queued")).toBe(false);
    expect(shouldPollRunShellLog("running")).toBe(true);
    expect(shouldPollRunShellLog("succeeded")).toBe(false);
  });
});

describe("runDetailRefetchIntervalMs", () => {
  it("polls run state only while the selected run remains queued", () => {
    expect(runDetailRefetchIntervalMs("queued")).toBe(5_000);
    expect(runDetailRefetchIntervalMs("running")).toBe(15_000);
    expect(runDetailRefetchIntervalMs("succeeded")).toBe(false);
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
