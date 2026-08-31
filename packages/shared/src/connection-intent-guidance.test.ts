import { describe, expect, it } from "vitest";
import {
  CONNECTION_INTENT_AGENT_GUIDANCE,
  CONNECTION_REQUEST_TOOL_DESCRIPTION,
  CONNECTION_RUNTIME_TOOL_NAMES,
  CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
} from "./connection-intent-guidance.js";

describe("connection intent agent guidance", () => {
  it.each([
    [
      "explicit connect request",
      "explicitly asks to connect",
      "connections_search",
    ],
    [
      "implicit service dependency",
      "implicitly depends on that service",
      "connections_search",
    ],
    [
      "already-ready service",
      "returns `ready`",
      "do not create a connection intent",
    ],
    [
      "available service",
      "returns `available` or `needs_user_action`",
      "connection_request",
    ],
    [
      "unavailable service",
      "returns `unavailable`",
      "do not call `connection_request`",
    ],
    ["arbitrary MCP URL", "arbitrary MCP URLs", "Do not use connection tools"],
    [
      "pending user action",
      "returns `needs_user_action`",
      "end the run in a waiting posture",
    ],
    [
      "continuation run",
      "On a continuation run",
      "instead of requesting it again",
    ],
  ])("gives an explicit instruction for %s", (_scenario, trigger, action) => {
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain(trigger);
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain(action);
  });

  it("names the canonical tools without embedding secrets or authorization URLs", () => {
    expect(CONNECTION_RUNTIME_TOOL_NAMES).toEqual([
      "connections_search",
      "connection_request",
    ]);
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).not.toMatch(
      /bearer|credential value|https?:\/\//i,
    );
  });

  it("keeps MCP descriptions aligned with the guidance decision points", () => {
    expect(CONNECTIONS_SEARCH_TOOL_DESCRIPTION).toContain(
      "usable access is uncertain",
    );
    expect(CONNECTIONS_SEARCH_TOOL_DESCRIPTION).toContain("arbitrary MCP URLs");
    expect(CONNECTION_REQUEST_TOOL_DESCRIPTION).toContain(
      "available or needs_user_action",
    );
    expect(CONNECTION_REQUEST_TOOL_DESCRIPTION).toContain("end the run");
    expect(CONNECTION_REQUEST_TOOL_DESCRIPTION).toContain("without retrying");
  });
});
