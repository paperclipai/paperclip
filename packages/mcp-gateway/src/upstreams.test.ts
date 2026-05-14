import { describe, expect, it } from "vitest";
import { matchUpstream, parseUpstreamMap } from "./upstreams.js";

describe("parseUpstreamMap", () => {
  it("parses a simple JSON object", () => {
    const map = parseUpstreamMap(
      '{"figma":"http://figma:8000/mcp","linear":"http://linear:8000/mcp"}',
      "test",
    );
    expect(map).toEqual({
      figma: "http://figma:8000/mcp",
      linear: "http://linear:8000/mcp",
    });
  });

  it("rejects non-object roots", () => {
    expect(() => parseUpstreamMap("[1,2]", "test")).toThrow(/JSON object/);
    expect(() => parseUpstreamMap('"foo"', "test")).toThrow(/JSON object/);
  });

  it("rejects empty maps", () => {
    expect(() => parseUpstreamMap("{}", "test")).toThrow(/no prefix/);
  });

  it("rejects bad prefixes", () => {
    expect(() => parseUpstreamMap('{"foo/bar":"http://x"}', "test")).toThrow(/match/);
    expect(() => parseUpstreamMap('{"":"http://x"}', "test")).toThrow();
  });

  it("rejects bad URLs", () => {
    expect(() => parseUpstreamMap('{"a":"ftp://x"}', "test")).toThrow(/http/);
    expect(() => parseUpstreamMap('{"a":""}', "test")).toThrow(/non-empty/);
  });
});

describe("matchUpstream", () => {
  const map = {
    figma: "http://figma:8000/mcp",
    "k8s-admin": "http://k8s:8080/mcp",
  };

  it("matches the prefix and forwards to the upstream", () => {
    const m = matchUpstream("/figma/mcp", map);
    expect(m?.upstreamUrl).toBe("http://figma:8000/mcp");
  });

  it("preserves trailing path beyond /mcp", () => {
    const m = matchUpstream("/figma/mcp/extra/path", map);
    expect(m?.upstreamUrl).toBe("http://figma:8000/mcp/extra/path");
  });

  it("matches multi-segment prefixes including hyphens", () => {
    const m = matchUpstream("/k8s-admin/mcp", map);
    expect(m?.upstreamUrl).toBe("http://k8s:8080/mcp");
  });

  it("returns null for unknown prefix", () => {
    expect(matchUpstream("/unknown/mcp", map)).toBeNull();
  });

  it("returns null for root path", () => {
    expect(matchUpstream("/", map)).toBeNull();
  });
});
