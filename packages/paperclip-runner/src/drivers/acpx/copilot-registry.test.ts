import { describe, expect, it, vi } from "vitest";
import type { CanonicalProviderEvent } from "../../provider-events.js";
import { COPILOT_ACP_CLIENT_CAPABILITIES, COPILOT_ACP_EVENT_METHOD } from "./copilot-events.js";
import { acpxProfileClientCapabilities, bindAcpxExtensionTurn, createAcpxProfileExtensionAdapter } from "./profile-extensions.js";
import { assertAcpxProfileEnvironment, classifyAcpxProfileError, verifyAcpxProfileInstallation } from "./profile-installation.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { verifyCopilotInstallation } from "./copilot-installation.js";
import { verifyCursorInstallation } from "./cursor-installation.js";

vi.mock("./copilot-installation.js", () => ({ verifyCopilotInstallation: vi.fn(async () => ({ commandDigest: "verified-by-native-factory" })) }));

vi.mock("./cursor-installation.js", () => ({ verifyCursorInstallation: vi.fn(async () => ({ commandDigest: "verified-cursor-factory" })) }));

const context = { workspacePath: "/workspace", sessionId: "backend-1", turnId: "turn-1" };
describe("Copilot provider registry conformance", () => {
  it("requires only explicitly bound Copilot credentials before starting the provider", () => {
    for (const environment of [{}, { COPILOT_GITHUB_TOKEN: "  " }, { COPILOT_GITHUB_TOKEN: "bad\0token" }, { GITHUB_TOKEN: "ambient-secret", GH_TOKEN: "ambient-secret" }]) {
      expect(() => assertAcpxProfileEnvironment("copilot", environment)).toThrow(expect.objectContaining({ code: "COPILOT_AUTH_REQUIRED", retryable: false }));
    }
    expect(() => assertAcpxProfileEnvironment("copilot", { COPILOT_GITHUB_TOKEN: "fixture-explicit-token" })).not.toThrow();
    expect(() => assertAcpxProfileEnvironment("codex", {})).not.toThrow();
  });
  it("selects only the Copilot native installer and preserves the exact caller-selected profile", async () => {
    const profile = resolveQualifiedAcpxProfile("copilot", "explicit-exact-model");
    expect(await verifyAcpxProfileInstallation(profile)).toMatchObject({ commandDigest: "verified-by-native-factory" });
    expect(verifyCopilotInstallation).toHaveBeenCalledExactlyOnceWith(profile);
    const cursorProfile = resolveQualifiedAcpxProfile("cursor", "exact-model");
    expect(await verifyAcpxProfileInstallation(cursorProfile)).toMatchObject({ commandDigest: "verified-cursor-factory" });
    expect(verifyCursorInstallation).toHaveBeenCalledExactlyOnceWith(cursorProfile);
    expect(verifyCopilotInstallation).toHaveBeenCalledTimes(1);
  });

  it("negotiates an isolated native event subscription and preserves every safe subagent field through the shared turn binder", async () => {
    const capabilities = acpxProfileClientCapabilities("copilot");
    expect(capabilities).toEqual(COPILOT_ACP_CLIENT_CAPABILITIES);
    (capabilities._meta as Record<string, unknown>)["github.com/copilot"] = {};
    expect(acpxProfileClientCapabilities("copilot")).toEqual(COPILOT_ACP_CLIENT_CAPABILITIES);
    expect(acpxProfileClientCapabilities("codex")).toEqual({});
    const emitted: CanonicalProviderEvent[] = [];
    const data = {
      toolCallId: "tool-1", agentName: "review", agentDisplayName: "Reviewer", agentDescription: "Review the change",
      model: "exact-model", parentId: "parent-1", agentType: "task", executionMode: "background", reasoningEffort: "high",
      contextTier: "large", firstDispatchedModel: "model-initial", configuredModelPreference: "model-preferred",
      explicitModelOverride: "model-explicit", modelOverrideReason: "task request", modelSelectionSource: "agent",
      taskModelSource: "task", factoryRunId: "factory-1", totalToolCalls: 3, totalTokens: 40, durationMs: 12.5,
      cancelled: false, resumable: true, multiTurn: true, explicitModelMatchesPreference: false, configuredModelMatchesActual: false,
    };
    const binder = bindAcpxExtensionTurn({ adapter: createAcpxProfileExtensionAdapter("copilot", context),
      active: () => true, sessionId: context.sessionId, waitForInput: async () => { throw new Error("No input allowed"); }, emit: event => emitted.push(event) });
    binder.onExtensionNotification(COPILOT_ACP_EVENT_METHOD, { sessionId: context.sessionId, type: "subagent.completed", data,
      agentId: "agent-2", timestamp: "2026-09-28T00:00:00Z" });
    await binder.drain();
    expect(emitted.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
    expect(emitted[0]!.payload).toMatchObject({ summary: "Copilot subagent completed.", details: expect.arrayContaining([
      { name: "source.method", value: COPILOT_ACP_EVENT_METHOD },
      { name: "source.eventType", value: "subagent.completed" },
      { name: "source.agentId", value: "agent-2" },
      { name: "source.sessionId", value: "backend-1" },
      { name: "source.timestamp", value: "2026-09-28T00:00:00Z" },
    ]) });
    expect(emitted[0]!.payload.scope).toBe("session");
    expect(emitted[0]!.payload).not.toHaveProperty("provenance");
    expect(emitted[0]!.payload.details).toEqual(expect.arrayContaining(Object.entries(data).map(([name, value]) => ({ name, value: String(value) }))));
  });

  it.each(["wrong_session", "stale_turn"])("rejects %s events at the shared boundary before presentation", async scenario => {
    const emitted: CanonicalProviderEvent[] = [];
    const binder = bindAcpxExtensionTurn({ adapter: createAcpxProfileExtensionAdapter("copilot", context),
      active: () => scenario !== "stale_turn", sessionId: context.sessionId, waitForInput: async () => ({}), emit: event => emitted.push(event) });
    binder.onExtensionNotification(COPILOT_ACP_EVENT_METHOD, { sessionId: scenario === "wrong_session" ? "agent-1" : "backend-1", type: "session.idle", data: {} });
    await expect(binder.drain()).rejects.toThrow();
    expect(emitted).toEqual([]);
  });

  it("classifies admission failures without copying credentials or masking unrelated runner errors", () => {
    for (const [message, code] of [
      ["COPILOT_GITHUB_TOKEN is required", "COPILOT_AUTH_REQUIRED"],
      ["Unauthorized token ghp_abcdefghijklmnopqrstuvwxyz", "COPILOT_AUTH_REQUIRED"],
      ["Organization policy denied with Bearer secretsecretsecret", "COPILOT_ENTITLEMENT_DENIED"],
      ["Model custom-model is not supported", "COPILOT_MODEL_UNAVAILABLE"],
    ]) {
      const error = classifyAcpxProfileError("copilot", new Error(message));
      expect(error).toMatchObject({ code, retryable: false });
      expect(String(error)).not.toMatch(/ghp_|secretsecretsecret|custom-model/);
    }
    expect(classifyAcpxProfileError("codex", new Error("Unauthorized"))).toBeNull();
    expect(classifyAcpxProfileError("copilot", new Error("native distribution digest mismatch"))).toBeNull();
  });
});
