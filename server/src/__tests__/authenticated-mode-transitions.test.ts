import { describe, expect, it } from "vitest";
import { getBoardClaimWarningUrl } from "../board-claim.js";
import { resolvePrivateHostnameAllowSet } from "../middleware/private-hostname-guard.js";

describe("Deployment Mode Transitions and Security", () => {
  it("resolves private hostname allow set correctly", () => {
    const set = resolvePrivateHostnameAllowSet({
      allowedHostnames: ["example.com", "TEST.local "],
      bindHost: "0.0.0.0", // should not be added as literal 0.0.0.0
    });

    expect(set.has("example.com")).toBe(true);
    expect(set.has("test.local")).toBe(true);
    expect(set.has("localhost")).toBe(true);
    expect(set.has("127.0.0.1")).toBe(true);
    expect(set.has("::1")).toBe(true);
    expect(set.has("0.0.0.0")).toBe(false);
  });

  it("adds specific bind host to allowed set", () => {
    const set = resolvePrivateHostnameAllowSet({
      allowedHostnames: [],
      bindHost: "192.168.1.5",
    });

    expect(set.has("192.168.1.5")).toBe(true);
  });

  it("handles board claim warning URL generation", async () => {
    let url = getBoardClaimWarningUrl("localhost", 3100);
    expect(url).toBe(null);
  });
});
