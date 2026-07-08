import { describe, expect, it } from "vitest";
import { resolveClaudeBridgeCwd, resolveClaudeBridgeTimeoutSec } from "./execute.js";

describe("resolveClaudeBridgeTimeoutSec", () => {
  it("preserves explicit zero timeout as disabled", () => {
    expect(resolveClaudeBridgeTimeoutSec({ timeoutSec: 0 })).toBe(0);
  });

  it("defaults missing timeout to disabled", () => {
    expect(resolveClaudeBridgeTimeoutSec({})).toBe(0);
  });

  it("preserves positive timeout values", () => {
    expect(resolveClaudeBridgeTimeoutSec({ timeoutSec: 5 })).toBe(5);
  });
});

describe("resolveClaudeBridgeCwd", () => {
  it("uses explicit adapter cwd when configured", () => {
    expect(
      resolveClaudeBridgeCwd(
        { cwd: "/remote/workspace" },
        { paperclipWorkspace: { cwd: "/paperclip/local/workspace" } },
        "/bridge/default",
      ),
    ).toBe("/remote/workspace");
  });

  it("does not adopt paperclipWorkspace.cwd for remote bridge execution", () => {
    expect(
      resolveClaudeBridgeCwd(
        {},
        { paperclipWorkspace: { cwd: "/paperclip/local/workspace" } },
        "/bridge/default",
      ),
    ).toBe("/bridge/default");
  });
});
