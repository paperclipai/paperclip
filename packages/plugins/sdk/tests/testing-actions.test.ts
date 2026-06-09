import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

const manifest = {
  id: "paperclip.test-actions",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Actions",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

describe("createTestHarness action context", () => {
  it("passes immutable authenticated actor context and overrides caller company scope", async () => {
    const harness = createTestHarness({ manifest });

    harness.ctx.actions.register("inspect", async (params, context) => ({
      paramsCompanyId: params.companyId,
      actor: context.actor,
      companyId: context.companyId,
      contextFrozen: Object.isFrozen(context),
      actorFrozen: Object.isFrozen(context.actor),
    }));

    const result = await harness.performAction<{
      paramsCompanyId: unknown;
      actor: {
        type: string;
        userId: string | null;
        agentId: string | null;
        runId: string | null;
        companyId: string | null;
      };
      companyId: string | null;
      contextFrozen: boolean;
      actorFrozen: boolean;
    }>(
      "inspect",
      { companyId: "spoofed-company", value: true },
      {
        companyId: "host-company",
        actor: {
          type: "user",
          userId: "board-user-1",
          runId: "run-1",
        },
      },
    );

    expect(result.paramsCompanyId).toBe("host-company");
    expect(result.companyId).toBe("host-company");
    expect(result.actor).toEqual({
      type: "user",
      userId: "board-user-1",
      agentId: null,
      runId: "run-1",
      companyId: "host-company",
    });
    expect(result.contextFrozen).toBe(true);
    expect(result.actorFrozen).toBe(true);
  });

  it("keeps existing one-argument action handlers compatible", async () => {
    const harness = createTestHarness({ manifest });
    harness.ctx.actions.register("legacy", async (params) => ({ ok: params.ok }));

    await expect(harness.performAction("legacy", { ok: true })).resolves.toEqual({ ok: true });
  });
});

describe("createTestHarness state client", () => {
  it("lists state by prefix with deterministic paging", async () => {
    const harness = createTestHarness({
      manifest: {
        ...manifest,
        capabilities: ["plugin.state.read", "plugin.state.write"],
      },
    });

    await harness.ctx.state.set({ scopeKind: "instance", stateKey: "link:b" }, { id: "b" });
    await harness.ctx.state.set({ scopeKind: "instance", stateKey: "other" }, { id: "other" });
    await harness.ctx.state.set({ scopeKind: "instance", stateKey: "link:a" }, { id: "a" });

    const firstPage = await harness.ctx.state.list({
      scopeKind: "instance",
      namespace: "default",
      stateKeyPrefix: "link:",
      limit: 1,
    });
    const secondPage = await harness.ctx.state.list({
      scopeKind: "instance",
      namespace: "default",
      stateKeyPrefix: "link:",
      limit: 1,
      offset: 1,
    });

    expect(firstPage).toMatchObject({
      entries: [{ stateKey: "link:a", value: { id: "a" } }],
      hasMore: true,
    });
    expect(secondPage).toMatchObject({
      entries: [{ stateKey: "link:b", value: { id: "b" } }],
      hasMore: false,
    });
  });
});
