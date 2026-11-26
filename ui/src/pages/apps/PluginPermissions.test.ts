import { describe, expect, it } from "vitest";
import { actionPolicy, groupPolicy, staleReads } from "./PluginPermissions";

const enabled = new Set(["read", "ask", "stale-ask"]);
const askFirst = new Set(["ask", "off-ask"]);

describe("plugin permission policies", () => {
  it("reads one action's policy from the enabled and ask-first sets", () => {
    expect(actionPolicy("read", enabled, askFirst)).toBe("allowed");
    expect(actionPolicy("ask", enabled, askFirst)).toBe("ask");
    expect(actionPolicy("off-ask", enabled, askFirst)).toBe("off");
    expect(actionPolicy("missing", enabled, askFirst)).toBe("off");
  });

  it("names a group policy only when every action agrees", () => {
    expect(groupPolicy(["read", "stale-ask"], enabled, askFirst)).toBe("allowed");
    expect(groupPolicy(["read", "ask"], enabled, askFirst)).toBe("custom");
    expect(groupPolicy(["missing", "off-ask"], enabled, askFirst)).toBe("off");
  });
});

describe("staleReads", () => {
  it("names the reads that failed, even when they still hold earlier data", () => {
    const fresh = { error: null, data: [1] };
    const failedRefresh = { error: new Error("offline"), data: [1] };
    expect(staleReads([fresh, fresh])).toEqual([]);
    expect(staleReads([fresh, failedRefresh])).toEqual([failedRefresh]);
  });
});
