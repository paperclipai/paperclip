import { describe, it, expect } from "vitest";
import { globMatch, resolveImage } from "../../src/image-allowlist.js";

describe("globMatch", () => {
  it("matches exact image", () => {
    expect(globMatch("ghcr.io/paperclipai/agent-runtime-claude:v1", "ghcr.io/paperclipai/agent-runtime-claude:v1")).toBe(true);
  });

  it("matches single-character wildcard", () => {
    expect(globMatch("ghcr.io/x:v?", "ghcr.io/x:v1")).toBe(true);
    expect(globMatch("ghcr.io/x:v?", "ghcr.io/x:v12")).toBe(false);
  });

  it("matches multi-character wildcard", () => {
    expect(globMatch("ghcr.io/paperclipai/*:v1", "ghcr.io/paperclipai/agent-runtime-claude:v1")).toBe(true);
    expect(globMatch("ghcr.io/paperclipai/*:v1", "docker.io/other/img:v1")).toBe(false);
  });

  it("does not allow wildcard to span slashes by default", () => {
    expect(globMatch("ghcr.io/*:v1", "ghcr.io/paperclipai/agent-runtime-claude:v1")).toBe(false);
  });
});

describe("resolveImage", () => {
  const defaults = { runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1" };

  it("uses adapter default when no override", () => {
    expect(resolveImage({ imageOverride: null }, defaults, { imageAllowList: [], imageRegistry: undefined })).toBe(
      "ghcr.io/paperclipai/agent-runtime-claude:v1",
    );
  });

  it("rewrites registry when imageRegistry is set", () => {
    expect(
      resolveImage(
        { imageOverride: null },
        defaults,
        { imageAllowList: [], imageRegistry: "registry.example.com/paperclip" },
      ),
    ).toBe("registry.example.com/paperclip/agent-runtime-claude:v1");
  });

  it("accepts imageOverride when in allowlist", () => {
    expect(
      resolveImage(
        { imageOverride: "registry.example.com/mine:v2" },
        defaults,
        { imageAllowList: ["registry.example.com/*:v2"], imageRegistry: undefined },
      ),
    ).toBe("registry.example.com/mine:v2");
  });

  it("rejects imageOverride not in allowlist", () => {
    expect(() =>
      resolveImage(
        { imageOverride: "evil.io/img:latest" },
        defaults,
        { imageAllowList: ["registry.example.com/*"], imageRegistry: undefined },
      ),
    ).toThrow(/not in allowlist/);
  });
});

describe("resolveImage with a URL-shaped imageRegistry", () => {
  it.each([
    ["https://registry.example.com/team", "registry.example.com/team/agent-runtime-claude:v1"],
    ["https://registry.example.com/team/", "registry.example.com/team/agent-runtime-claude:v1"],
    ["http://localhost:5000/x", "localhost:5000/x/agent-runtime-claude:v1"],
    ["registry.example.com/team", "registry.example.com/team/agent-runtime-claude:v1"],
  ])("rewrites %s without the scheme", (registry, expected) => {
    expect(
      resolveImage(
        { imageOverride: null },
        { runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1" },
        { imageAllowList: [], imageRegistry: registry },
      ),
    ).toBe(expected);
  });
});
