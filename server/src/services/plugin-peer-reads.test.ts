import { describe, expect, it } from "vitest";
import { checkPeerEntityAccess } from "./plugin-peer-reads.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

function makeManifest(overrides: Partial<PaperclipPluginManifestV1> = {}): PaperclipPluginManifestV1 {
  return {
    id: "test.provider",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Provider",
    description: "Test",
    author: "Test",
    categories: ["automation"],
    capabilities: [],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

describe("checkPeerEntityAccess — WF-3 access control", () => {
  const consumerKey = "test.consumer";
  const providerManifest = makeManifest({
    peerReads: {
      allow: [
        { entityType: "gitea-pr", consumers: ["test.consumer", "other.consumer"] },
        { entityType: "gitea-check", consumers: [] },
      ],
    },
  });

  it("allows access when consumer is on the allowlist", () => {
    const result = checkPeerEntityAccess(consumerKey, providerManifest, "gitea-pr");
    expect(result.allowed).toBe(true);
  });

  it("denies access when consumer is NOT on the allowlist for the entity type", () => {
    const result = checkPeerEntityAccess("unauthorized.plugin", providerManifest, "gitea-pr");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("denied");
  });

  it("denies access when consumers array is empty", () => {
    const result = checkPeerEntityAccess(consumerKey, providerManifest, "gitea-check");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("denied");
  });

  it("denies access when entityType is not in peerReads.allow", () => {
    const result = checkPeerEntityAccess(consumerKey, providerManifest, "unknown-entity");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("denied");
  });

  it("denies access when provider has no peerReads declaration", () => {
    const noReadManifest = makeManifest({ peerReads: undefined });
    const result = checkPeerEntityAccess(consumerKey, noReadManifest, "gitea-pr");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("denied");
  });

  it("error reason is indistinguishable from denied (no leakage)", () => {
    const r1 = checkPeerEntityAccess("any.plugin", makeManifest({ peerReads: undefined }), "gitea-pr");
    const r2 = checkPeerEntityAccess("any.plugin", providerManifest, "missing-type");
    expect(r1.reason).toBe("denied");
    expect(r2.reason).toBe("denied");
  });

  it("entityType matching is case-sensitive", () => {
    const result = checkPeerEntityAccess(consumerKey, providerManifest, "Gitea-PR");
    expect(result.allowed).toBe(false);
  });
});

describe("PEER_ENTITY_MAX_LIMIT", () => {
  it("PEER_ENTITY_MAX_LIMIT is 100", async () => {
    const { PEER_ENTITY_MAX_LIMIT } = await import("./plugin-peer-reads.js");
    expect(PEER_ENTITY_MAX_LIMIT).toBe(100);
  });
});
