import { describe, expect, it } from "vitest";

import {
  assertOpenCodeProxyCollaborationMode,
  openCodeProxyCollaborationModes,
} from "./opencode-proxy-collaboration-mode.js";

describe("OpenCode runnerd proxy collaboration mode", () => {
  it("advertises proxy-owned planning against the resolved model", () => {
    expect(
      openCodeProxyCollaborationModes(
        "openrouter/deepseek/deepseek-v4-flash-0731",
      ),
    ).toEqual({
      data: [
        {
          name: "Plan",
          mode: "plan",
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
          reasoning_effort: null,
        },
      ],
    });
  });

  it("accepts the negotiated plan payload on turn/start", () => {
    expect(() =>
      assertOpenCodeProxyCollaborationMode({
        collaborationMode: {
          mode: "plan",
          settings: { model: "openrouter/example" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects collaboration modes the proxy does not implement", () => {
    expect(() =>
      assertOpenCodeProxyCollaborationMode({
        collaborationMode: { mode: "pair-programming" },
      }),
    ).toThrow("Unsupported OpenCode proxy collaboration mode pair-programming");
  });
});
