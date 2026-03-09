import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import {
  createDefaultCreateValues,
  resolveDefaultManagerId,
} from "./agent-config-defaults";

describe("createDefaultCreateValues", () => {
  it("defaults new specialist hires to codex with the current default model", () => {
    const values = createDefaultCreateValues();

    expect(values.adapterType).toBe("codex_local");
    expect(values.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(values.dangerouslyBypassSandbox).toBe(true);
  });

  it("applies adapter-specific model defaults without carrying codex sandbox bypass to other adapters", () => {
    const cursorValues = createDefaultCreateValues("cursor");
    const claudeValues = createDefaultCreateValues("claude_local");

    expect(cursorValues.model).toBe(DEFAULT_CURSOR_LOCAL_MODEL);
    expect(cursorValues.dangerouslyBypassSandbox).toBe(false);
    expect(claudeValues.model).toBe("");
    expect(claudeValues.dangerouslyBypassSandbox).toBe(false);
  });
});

describe("resolveDefaultManagerId", () => {
  it("prefers the root CEO when selecting a default manager", () => {
    const managerId = resolveDefaultManagerId([
      { id: "ceo-child", role: "ceo", reportsTo: "cto", status: "active" },
      { id: "cto", role: "cto", reportsTo: null, status: "active" },
      { id: "ceo-root", role: "ceo", reportsTo: null, status: "active" },
    ]);

    expect(managerId).toBe("ceo-root");
  });

  it("returns null when no active CEO exists", () => {
    const managerId = resolveDefaultManagerId([
      { id: "former-ceo", role: "ceo", reportsTo: null, status: "terminated" },
      { id: "cto", role: "cto", reportsTo: null, status: "active" },
    ]);

    expect(managerId).toBeNull();
  });
});
