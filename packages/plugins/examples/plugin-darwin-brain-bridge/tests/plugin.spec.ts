import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin, { __setDarwinInvokerForTests } from "../src/worker.js";

describe("darwin brain bridge plugin", () => {
  afterEach(() => {
    __setDarwinInvokerForTests(async (_options, _toolName, _args) => {
      throw new Error("Darwin invoker not stubbed for this test");
    });
  });

  it("registers tools and executes global search", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        companyPoliciesJson: "[]",
        agentPoliciesJson: "[]",
      },
    });

    __setDarwinInvokerForTests(async (_options, toolName, args) => {
      expect(toolName).toBe("darwin_search");
      expect(args).toMatchObject({ query: "semantic memory", top_k: 3 });
      return {
        content: [{ type: "text", text: "search ok" }],
      };
    });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool("darwin.search", { query: "semantic memory", topK: 3 });
    expect(result).toMatchObject({ content: "search ok" });
  });

  it("uses tenant policy for tenant search", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        companyPoliciesJson: JSON.stringify([
          { companyId: "company-test", namespace: "monitor-agency", accessMode: "read-write" },
        ]),
      },
    });

    __setDarwinInvokerForTests(async (_options, toolName, args) => {
      expect(toolName).toBe("darwin_search_tenant");
      expect(args).toMatchObject({ tenant: "monitor-agency", query: "provider pricing" });
      return {
        content: [{ type: "text", text: "tenant search ok" }],
      };
    });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool("darwin.searchTenant", { query: "provider pricing" });
    expect(result).toMatchObject({ content: "tenant search ok" });
  });

  it("rejects tenant search when no namespace policy exists", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    __setDarwinInvokerForTests(async () => ({ content: [{ type: "text", text: "unexpected" }] }));

    await plugin.definition.setup(harness.ctx);
    await expect(harness.executeTool("darwin.searchTenant", { query: "x" })).rejects.toThrow(
      "No Darwin namespace policy configured",
    );
  });

  it("rejects store for read-only policy", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        companyPoliciesJson: JSON.stringify([
          { companyId: "company-test", namespace: "lua-marketing", accessMode: "read" },
        ]),
      },
    });

    __setDarwinInvokerForTests(async () => {
      throw new Error("should not invoke Darwin");
    });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool("darwin.store", { id: "a", text: "b" });
    expect(result).toMatchObject({ error: "This agent is not allowed to write to Darwin Brain" });
  });

  it("allows store for read-write policy", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        companyPoliciesJson: JSON.stringify([
          { companyId: "company-test", namespace: "lua-marketing", accessMode: "read-write" },
        ]),
      },
    });

    __setDarwinInvokerForTests(async (_options, toolName, args) => {
      expect(toolName).toBe("darwin_store");
      expect(args).toMatchObject({ tenant: "lua-marketing", id: "entry_1", text: "stored text" });
      return {
        content: [{ type: "text", text: "store ok" }],
      };
    });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool("darwin.store", { id: "entry_1", text: "stored text" });
    expect(result).toMatchObject({ content: "store ok" });
    expect(harness.activity).toHaveLength(1);
  });

  it("rejects promotion without promote access", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        companyPoliciesJson: JSON.stringify([
          { companyId: "company-test", namespace: "monitor-agency", accessMode: "read-write" },
        ]),
      },
    });

    __setDarwinInvokerForTests(async () => {
      throw new Error("should not invoke Darwin");
    });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool("darwin.store", {
      id: "entry_2",
      text: "important learning",
      promote: true,
    });
    expect(result).toMatchObject({
      error: "This agent is not allowed to promote knowledge to shared Darwin memory",
    });
  });

  it("allows promotion for promote access", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        companyPoliciesJson: JSON.stringify([
          { companyId: "company-test", namespace: "monitor-agency", accessMode: "promote" },
        ]),
        sharedNamespace: "darwin-shared",
      },
    });

    __setDarwinInvokerForTests(async (_options, toolName, args) => {
      expect(toolName).toBe("darwin_store");
      expect(args).toMatchObject({ tenant: "darwin-shared", id: "entry_3" });
      return {
        content: [{ type: "text", text: "promote ok" }],
      };
    });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool("darwin.store", {
      id: "entry_3",
      text: "promote this",
      promote: true,
    });
    expect(result).toMatchObject({ content: "promote ok" });
    expect(harness.activity).toHaveLength(1);
  });

  it("returns info through Darwin MCP", async () => {
    const harness = createTestHarness({ manifest, config: {} });

    __setDarwinInvokerForTests(async (_options, toolName, args) => {
      expect(toolName).toBe("darwin_info");
      expect(args).toMatchObject({ namespace: "lua-marketing" });
      return {
        content: [{ type: "text", text: "info ok" }],
      };
    });

    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool("darwin.info", { namespace: "lua-marketing" });
    expect(result).toMatchObject({ content: "info ok" });
  });
});
