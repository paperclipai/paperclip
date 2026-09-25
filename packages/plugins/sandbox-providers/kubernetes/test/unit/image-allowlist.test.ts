import { describe, it, expect } from "vitest";
import { globMatch, resolveImage, imagePullPolicyFor } from "../../src/image-allowlist.js";

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

describe("imagePullPolicyFor", () => {
  it("uses Always for :latest so nodes can't cache a stale floating tag", () => {
    expect(imagePullPolicyFor("ghcr.io/paperclipai/agent-runtime-claude:latest")).toBe("Always");
  });

  it("uses Always for other known floating aliases (dev/main/stable)", () => {
    expect(imagePullPolicyFor("ghcr.io/paperclipai/agent-runtime-claude:dev")).toBe("Always");
    expect(imagePullPolicyFor("ghcr.io/paperclipai/agent-runtime-claude:main")).toBe("Always");
    expect(imagePullPolicyFor("ghcr.io/paperclipai/agent-runtime-claude:stable")).toBe("Always");
  });

  it("uses Always when no tag is given (Docker defaults to :latest)", () => {
    expect(imagePullPolicyFor("ghcr.io/paperclipai/agent-runtime-claude")).toBe("Always");
  });

  it("uses IfNotPresent for an immutable-looking version tag", () => {
    expect(imagePullPolicyFor("ghcr.io/paperclipai/agent-runtime-claude:v1")).toBe("IfNotPresent");
    expect(imagePullPolicyFor("ghcr.io/paperclipai/agent-runtime-claude:git-38d8f37")).toBe(
      "IfNotPresent",
    );
  });

  it("uses IfNotPresent for a digest-pinned reference even if it happens to say latest", () => {
    expect(
      imagePullPolicyFor(
        "ghcr.io/paperclipai/agent-runtime-claude@sha256:" + "a".repeat(64),
      ),
    ).toBe("IfNotPresent");
  });
});
