import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "./constants.js";
import { pluginManifestV1Schema } from "./validators/plugin.js";
import type { PaperclipPluginManifestV1, PluginPeerReadsDeclaration } from "./types/plugin.js";

describe("WF-3 peer-reads capability", () => {
  it("PLUGIN_CAPABILITIES includes plugins.peer-reads.read", () => {
    expect(PLUGIN_CAPABILITIES).toContain("plugins.peer-reads.read");
  });
});

describe("WF-3 manifest peer-reads declaration", () => {
  it("PaperclipPluginManifestV1 accepts peerReads with allow list", () => {
    const manifest: Pick<PaperclipPluginManifestV1, "peerReads"> = {
      peerReads: {
        allow: [
          { entityType: "gitea-pr", consumers: ["paperclip.workflows"] },
        ],
      },
    };
    expect(manifest.peerReads?.allow[0].entityType).toBe("gitea-pr");
    expect(manifest.peerReads?.allow[0].consumers).toContain("paperclip.workflows");
  });

  it("PluginPeerReadsDeclaration allows empty consumers array (validated at host level)", () => {
    const decl: PluginPeerReadsDeclaration = {
      allow: [{ entityType: "my-entity", consumers: [] }],
    };
    expect(decl.allow).toHaveLength(1);
  });

  it("PaperclipPluginManifestV1 peerReads is optional", () => {
    const manifest: Partial<Pick<PaperclipPluginManifestV1, "peerReads">> = {};
    expect(manifest.peerReads).toBeUndefined();
  });
});

describe("WF-3 manifest Zod schema round-trip", () => {
  const baseManifest = {
    id: "test.plugin",
    apiVersion: 1 as const,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "Test",
    author: "Test",
    categories: ["automation" as const],
    capabilities: ["plugins.peer-reads.read" as const],
    entrypoints: { worker: "dist/worker.js" },
  };

  it("pluginManifestV1Schema preserves peerReads through parse", () => {
    const result = pluginManifestV1Schema.parse({
      ...baseManifest,
      peerReads: {
        allow: [{ entityType: "gitea-pr", consumers: ["test.consumer"] }],
      },
    });
    expect(result.peerReads).toBeDefined();
    expect(result.peerReads?.allow[0].entityType).toBe("gitea-pr");
    expect(result.peerReads?.allow[0].consumers).toContain("test.consumer");
  });

  it("pluginManifestV1Schema accepts manifest without peerReads", () => {
    const result = pluginManifestV1Schema.parse(baseManifest);
    expect(result.peerReads).toBeUndefined();
  });

  it("pluginManifestV1Schema rejects peerReads.allow entry with empty entityType", () => {
    expect(() =>
      pluginManifestV1Schema.parse({
        ...baseManifest,
        peerReads: { allow: [{ entityType: "", consumers: ["x"] }] },
      }),
    ).toThrow();
  });

  it("pluginManifestV1Schema accepts peerReads.allow as empty array (matches TS type)", () => {
    const result = pluginManifestV1Schema.parse({
      ...baseManifest,
      peerReads: { allow: [] },
    });
    expect(result.peerReads?.allow).toHaveLength(0);
  });
});
