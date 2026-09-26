import { describe, it, expect } from "vitest";
import manifest, { PLUGIN_ID, TOOL } from "../src/manifest.js";

describe("plugin-paperclip-github manifest", () => {
  it("has the stable plugin id and api version", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.id).toBe("paperclipai.plugin-paperclip-github");
    expect(manifest.apiVersion).toBe(1);
  });

  it("declares the capabilities every tool needs", () => {
    const caps = new Set(manifest.capabilities);
    expect(caps.has("agent.tools.register")).toBe(true);
    expect(caps.has("secrets.read-ref")).toBe(true);
    expect(caps.has("activity.log.write")).toBe(true);
  });

  it("registers all six v0.1 tools by stable name", () => {
    const toolNames = new Set((manifest.tools ?? []).map((t) => t.name));
    expect(toolNames).toEqual(
      new Set([
        TOOL.OPEN_PR,
        TOOL.GET_PR,
        TOOL.GET_CHECK_RUNS,
        TOOL.CREATE_CHECK_RUN,
        TOOL.ENQUEUE_MERGE,
        TOOL.LIST_ISSUES,
      ]),
    );
  });

  it("every tool carries a non-empty description and an object schema", () => {
    for (const t of manifest.tools ?? []) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.parametersSchema).toBeTruthy();
      const schema = t.parametersSchema as { type?: string; properties?: unknown };
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeTruthy();
    }
  });

  it("worker entrypoint points to the built worker bundle", () => {
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
  });
});
