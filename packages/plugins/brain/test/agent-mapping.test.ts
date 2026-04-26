import { describe, it, expect } from "vitest";
import { mapAgentId, parseAgentMap } from "../src/agent-mapping.js";

describe("mapAgentId", () => {
  const map = {
    "82729ae0-aaaa-bbbb-cccc-111111111111": "CEO",
    "82729ae0-aaaa-bbbb-cccc-222222222222": "CTO",
  };

  it("maps known UUID to ACL key", () => {
    expect(mapAgentId("82729ae0-aaaa-bbbb-cccc-111111111111", map)).toBe("CEO");
  });

  it("falls back to UUID for unmapped agent", () => {
    expect(mapAgentId("99999999-9999-9999-9999-999999999999", map)).toBe(
      "99999999-9999-9999-9999-999999999999",
    );
  });

  it("returns 'unknown' for undefined input", () => {
    expect(mapAgentId(undefined, map)).toBe("unknown");
  });
});

describe("parseAgentMap", () => {
  it("returns empty object for undefined", () => {
    expect(parseAgentMap(undefined)).toEqual({});
  });

  it("returns empty for malformed JSON", () => {
    expect(parseAgentMap("not json")).toEqual({});
  });

  it("parses valid JSON object", () => {
    expect(parseAgentMap('{"a":"CEO","b":"CTO"}')).toEqual({ a: "CEO", b: "CTO" });
  });

  it("filters non-string values", () => {
    expect(parseAgentMap('{"a":"CEO","b":42}')).toEqual({ a: "CEO" });
  });
});
