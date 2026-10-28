import { describe, expect, it } from "vitest";
import { agentRuntimeSettingsPatchSchema, type AgentRuntimeSettingsPatch } from "@paperclipai/shared";
import { prepareRuntimeSettingsPatch } from "../services/agent-runtime-settings.js";

const connection = { provider: "openai", method: "api_key", mode: "responsible_user" } as const;
const existing = { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "old", cwd: "/workspace", env: { PRESERVE: "value" } }, runtimeConfig: { heartbeat: { intervalSec: 900 }, aiConnection: connection }, status: "paused" };
const settings: AgentRuntimeSettingsPatch = { harness: "codex_local", model: "new", expected: { model: "old", aiConnection: connection } };

describe("roster runtime settings patches", () => {
  it("changes only the requested fields and retains unrelated runtime settings", () => {
    expect(prepareRuntimeSettingsPatch(existing, { runtimeSettings: settings })).toEqual({ adapterConfig: { model: "new" } });
    const next = { ...connection, method: "subscription" } as const;
    expect(prepareRuntimeSettingsPatch(existing, { runtimeSettings: { ...settings, model: undefined, aiConnection: next } })).toEqual({ runtimeConfig: { heartbeat: { intervalSec: 900 }, aiConnection: next } });
    expect(existing.adapterConfig.model).toBe("old");
  });
  it("rejects stale previews, harness switches, and mixed broad patches", () => {
    expect(() => prepareRuntimeSettingsPatch(existing, { runtimeSettings: { ...settings, harness: "claude_local" } })).toThrow("harness changed");
    expect(() => prepareRuntimeSettingsPatch(existing, { runtimeSettings: { ...settings, expected: { ...settings.expected, model: "stale" } } })).toThrow("connection or model changed");
    expect(() => prepareRuntimeSettingsPatch(existing, { runtimeSettings: settings, name: "Unexpected rename" })).toThrow("cannot be combined");
    expect(() => prepareRuntimeSettingsPatch({ ...existing, status: "terminated" }, { runtimeSettings: settings })).toThrow("cannot be updated");
  });
  it("requires an explicit edit and rejects extra fields inside the intent", () => {
    expect(agentRuntimeSettingsPatchSchema.safeParse({ harness: "codex_local", expected: settings.expected }).success).toBe(false);
    expect(agentRuntimeSettingsPatchSchema.safeParse({ ...settings, model: " " }).success).toBe(false);
    expect(agentRuntimeSettingsPatchSchema.safeParse({ ...settings, status: "idle" }).success).toBe(false);
  });
});
