import { describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";

describe("claude-local config schema", () => {
  const fields = getConfigSchema().fields;
  const byKey = (key: string) => fields.find((field) => field.key === key);

  it("declares browser/model/effort as first-class, UI-discoverable fields", () => {
    // HELA-7806: these were undiscoverable in the UI before (only engine/ACP
    // fields were declared), so they lived as undocumented config keys.
    for (const key of ["model", "effort", "chrome", "mcpConfigPath"]) {
      expect(byKey(key), `expected field "${key}" to be declared`).toBeDefined();
    }
  });

  it("keeps the browser default off so enabling it stays an explicit, per-agent choice", () => {
    const chrome = byKey("chrome");
    expect(chrome?.type).toBe("toggle");
    expect(chrome?.default).toBe(false);
  });

  it("exposes the reasoning-effort levels the CLI lane accepts", () => {
    const effort = byKey("effort");
    expect(effort?.type).toBe("select");
    const values = (effort?.options ?? []).map((option) => option.value);
    expect(values).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
  });

  it("offers a text path for a browser MCP config (cross-lane browser access)", () => {
    const mcpConfigPath = byKey("mcpConfigPath");
    expect(mcpConfigPath?.type).toBe("text");
  });

  it("keeps model/effort/chrome/mcpConfigPath visible on every engine (not ACP-gated)", () => {
    for (const key of ["model", "effort", "chrome", "mcpConfigPath"]) {
      expect(byKey(key)?.meta?.visibleWhen, `field "${key}" should not be engine-gated`).toBeUndefined();
    }
  });
});
