import { describe, expect, it } from "vitest";

import { parseOpenCodeProxyPermissionMode } from "./opencode-proxy-permission-mode.js";

describe("OpenCode runnerd proxy permission mode", () => {
  it.each(["allow", "ask", "deny"] as const)(
    "admits the exact %s mode",
    (mode) => {
      expect(parseOpenCodeProxyPermissionMode(mode)).toBe(mode);
    },
  );

  it("defaults an unset or empty mode to ask", () => {
    expect(parseOpenCodeProxyPermissionMode(undefined)).toBe("ask");
    expect(parseOpenCodeProxyPermissionMode("  ")).toBe("ask");
  });

  it("rejects an unknown mode", () => {
    expect(() => parseOpenCodeProxyPermissionMode("approve-all")).toThrow(
      "PAPERCLIP_OPENCODE_PERMISSION_MODE is invalid",
    );
  });
});
