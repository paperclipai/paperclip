import { describe, expect, it } from "vitest";
import { parseProviderMode } from "../../contracts/provider-mode.js";
import { createAcpxModeBinding, resolveAcpxProviderMode } from "./provider-mode.js";

describe("provider-neutral mode transport and adapter admission", () => {
  it.each(["agent", "plan", "ask", "architect", "custom/build"])("carries opaque mode %s without a vendor enum", mode => {
    expect(parseProviderMode(mode)).toBe(mode);
  });
  it.each([null, 1, {}, "", " ", "x".repeat(241), "plan\0", "plan\n", "plan\u0085"])("rejects invalid mode %j", mode => {
    expect(() => parseProviderMode(mode)).toThrow(/Provider mode/);
  });
  it("does not invent a mode for a provider without a mode adapter", () => {
    expect(parseProviderMode(undefined)).toBeUndefined();
    expect(resolveAcpxProviderMode("codex", undefined)).toBeUndefined();
    expect(createAcpxModeBinding("codex", undefined)).toBeNull();
    expect(() => resolveAcpxProviderMode("codex", "architect")).toThrow(/does not support configurable/);
  });
  it("lets Cursor own its default, vocabulary, and native admission", () => {
    expect(resolveAcpxProviderMode("cursor", undefined)).toBe("agent");
    expect(() => resolveAcpxProviderMode("cursor", "architect")).toThrow(/Invalid Cursor session mode/);
    const binding = createAcpxModeBinding("cursor", "plan")!;
    expect(binding.selectedMode).toBe("plan");
    expect(binding.configKey).toBe("mode");
    expect(binding.assertReady).toThrow(/native mode/);
    const guard = binding.createGuard();
    guard("outbound", { id: 1, method: "session/new", params: {} });
    guard("inbound", { id: 1, result: { sessionId: "native", modes: { currentModeId: "plan" }, configOptions: [{ id: "mode", currentValue: "plan" }] } });
    binding.assertReady();
    expect(binding.isReady()).toBe(true);
  });
});
