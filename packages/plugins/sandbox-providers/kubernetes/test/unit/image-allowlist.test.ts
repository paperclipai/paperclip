import { describe, it, expect } from "vitest";
import {
  globMatch,
  ImageDigestRequiredError,
  InvalidPlatformDigestError,
  isValidSha256Digest,
  parseDigestImageRef,
  resolveImage,
  resolveImageDetailed,
  rewriteRegistry,
} from "../../src/image-allowlist.js";

const VALID_DIGEST = `sha256:${"a".repeat(64)}`;
const VALID_PLATFORM_DIGEST = `sha256:${"b".repeat(64)}`;

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

describe("parseDigestImageRef & isValidSha256Digest", () => {
  it("parses immutable digest without tag", () => {
    expect(parseDigestImageRef(`ghcr.io/paperclipai/agent-runtime-claude@${VALID_DIGEST}`)).toEqual({
      repository: "ghcr.io/paperclipai/agent-runtime-claude",
      tag: null,
      digest: VALID_DIGEST,
    });
  });

  it("parses immutable digest with explicit port and optional tag", () => {
    expect(parseDigestImageRef(`registry.example:5000/org/agent-runtime:v1@${VALID_DIGEST}`)).toEqual({
      repository: "registry.example:5000/org/agent-runtime",
      tag: "v1",
      digest: VALID_DIGEST,
    });
    expect(parseDigestImageRef(`registry.example:5000/org/agent-runtime@${VALID_DIGEST}`)).toEqual({
      repository: "registry.example:5000/org/agent-runtime",
      tag: null,
      digest: VALID_DIGEST,
    });
  });

  it("rejects floating tags, truncated digests, and uppercase hex", () => {
    expect(parseDigestImageRef("ghcr.io/paperclipai/agent-runtime-claude:latest")).toBeNull();
    expect(parseDigestImageRef("ghcr.io/paperclipai/agent-runtime-claude@sha256:1234")).toBeNull();
    expect(parseDigestImageRef(`ghcr.io/paperclipai/agent-runtime-claude@sha256:${"A".repeat(64)}`)).toBeNull();
    expect(isValidSha256Digest(VALID_DIGEST)).toBe(true);
    expect(isValidSha256Digest("sha256:short")).toBe(false);
  });
});

describe("rewriteRegistry", () => {
  it("preserves @sha256 digest and optional tag when rewriting", () => {
    expect(
      rewriteRegistry(`ghcr.io/paperclipai/team/agent-runtime@${VALID_DIGEST}`, "registry.example:5000/mirror"),
    ).toBe(`registry.example:5000/mirror/team/agent-runtime@${VALID_DIGEST}`);

    expect(
      rewriteRegistry(`ghcr.io/paperclipai/agent-runtime:v1@${VALID_DIGEST}`, "registry.example:5000/mirror/"),
    ).toBe(`registry.example:5000/mirror/agent-runtime:v1@${VALID_DIGEST}`);
  });

  it("does not corrupt host:port registries or duplicate matching prefix", () => {
    expect(
      rewriteRegistry("registry.example:5000/org/img", "registry.example:5000/org"),
    ).toBe("registry.example:5000/org/img");

    expect(
      rewriteRegistry("registry.example:5000/org/img", "mirror.example:8443/team"),
    ).toBe("mirror.example:8443/team/img");
  });
});

describe("resolveImage & resolveImageDetailed", () => {
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

  it("enforces immutable digest when requireDigest is true", () => {
    expect(() =>
      resolveImageDetailed(
        { imageOverride: "ghcr.io/paperclipai/agent-runtime-claude:latest" },
        defaults,
        { imageAllowList: ["ghcr.io/paperclipai/*"], requireDigest: true },
      ),
    ).toThrow(ImageDigestRequiredError);

    expect(() =>
      resolveImageDetailed(
        { imageOverride: null },
        defaults,
        { imageAllowList: [], requireDigest: true },
      ),
    ).toThrow(ImageDigestRequiredError);
  });

  it("returns structured ResolvedImageRef with rewritten registry and platformDigest", () => {
    const res = resolveImageDetailed(
      {
        imageOverride: `ghcr.io/paperclipai/agent-runtime-claude@${VALID_DIGEST}`,
        platformDigest: VALID_PLATFORM_DIGEST,
      },
      defaults,
      {
        imageAllowList: ["ghcr.io/paperclipai/*"],
        imageRegistry: "registry.example:5000/paperclip",
        requireDigest: true,
      },
    );
    expect(res).toEqual({
      image: `registry.example:5000/paperclip/agent-runtime-claude@${VALID_DIGEST}`,
      digest: VALID_DIGEST,
      expectedPlatformDigest: VALID_PLATFORM_DIGEST,
      source: "override",
    });
  });

  it("rejects malformed platformDigest", () => {
    expect(() =>
      resolveImageDetailed(
        { imageOverride: null, platformDigest: "md5:1234" },
        defaults,
        { imageAllowList: [] },
      ),
    ).toThrow(InvalidPlatformDigestError);
  });
});
