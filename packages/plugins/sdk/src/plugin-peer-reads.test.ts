import { describe, expect, it } from "vitest";
import type {
  PeerEntityRecord,
  PluginPeerEntitiesClient,
  PluginContext,
} from "./types.js";

describe("WF-3 SDK peer-reads types", () => {
  it("PeerEntityRecord has the expected shape", () => {
    const record: PeerEntityRecord = {
      id: "uuid-1",
      entityType: "gitea-pr",
      scopeKind: "issue",
      scopeId: "issue-uuid",
      externalId: "PR-42",
      title: "Fix the thing",
      status: "open",
      data: { url: "https://example.com/pr/42" },
      createdAt: "2026-05-02T00:00:00Z",
      updatedAt: "2026-05-02T00:00:00Z",
    };
    expect(record.entityType).toBe("gitea-pr");
    expect(record.data).toEqual({ url: "https://example.com/pr/42" });
  });

  it("PluginPeerEntitiesClient has list and get methods", () => {
    const client: PluginPeerEntitiesClient = {
      list: async (_params) => [],
      get: async (_params) => null,
    };
    expect(typeof client.list).toBe("function");
    expect(typeof client.get).toBe("function");
  });

  it("PluginContext has a plugins.peer.entities property", () => {
    type HasPlugins = Pick<PluginContext, "plugins">;
    const ctx: HasPlugins = {
      plugins: {
        peer: {
          entities: {
            list: async (_params) => [],
            get: async (_params) => null,
          },
        },
      },
    };
    expect(typeof ctx.plugins.peer.entities.list).toBe("function");
  });
});
