import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ACPX_QUALIFICATION_ENV, resolveAcpxQualification } from "./acpx-qualification.js";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerProviderProfile, resolvePaperclipRunnerNativeProviderInput } from "./provider-profile.js";

const provider = { kind: "acpx", agent: "copilot", model: "exact-model", permissionMode: "approve-all" } as NativeExecutionInput["provider"];
const authorize = (value: unknown) => ({ [ACPX_QUALIFICATION_ENV]: JSON.stringify(value) });
describe("host ACPX qualification admission", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(["copilot", "pi"])("admits %s through agent validation and native input only for the exact host pair", (agent) => {
    const config = { provider: "acpx", acpxAgent: agent, model: "exact-model" };
    vi.stubEnv(ACPX_QUALIFICATION_ENV, undefined);
    expect(() => resolvePaperclipRunnerProviderProfile(config)).toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_agent_unavailable" }));
    expect(() => resolvePaperclipRunnerProviderProfile({ ...config, env: authorize([{ agent, model: config.model }]), [ACPX_QUALIFICATION_ENV]: JSON.stringify([{ agent, model: config.model }]) })).toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_agent_unavailable" }));
    vi.stubEnv(ACPX_QUALIFICATION_ENV, JSON.stringify([{ agent, model: config.model }]));
    expect(resolvePaperclipRunnerProviderProfile(config)).toMatchObject({ acpxAgent: agent, model: config.model });
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: config })).toMatchObject({ acpxAgent: agent, model: config.model });
    expect(() => resolvePaperclipRunnerProviderProfile({ ...config, model: "other-model" })).toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_qualification_invalid" }));
    expect(() => resolvePaperclipRunnerProviderProfile({ ...config, model: "" })).toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_model_required" }));
  });
  it("keeps normal candidate execution closed and admits only the exact operator pair", () => {
    expect(resolveAcpxQualification(provider, {})).toBeUndefined();
    expect(resolveAcpxQualification(provider, authorize([{ agent: "copilot", model: "exact-model" }]))).toBe("copilot");
    for (const entries of [[{ agent: "pi", model: "exact-model" }], [{ agent: "copilot", model: "other-model" }]]) {
      expect(() => resolveAcpxQualification(provider, authorize(entries))).toThrow("exact model");
    }
  });
  it.each([[], {}, [{ agent: "cursor", model: "" }], [{ agent: "cursor", model: " exact-model" }],
    [{ agent: "cursor", model: "exact-model", allowAll: true }], [{ agent: "claude", model: "exact-model" }],
    [{ agent: "cursor", model: "exact-model" }, { agent: "cursor", model: "exact-model" }],
  ])("rejects malformed or broad authorization %j", entries => {
    expect(() => resolveAcpxQualification(provider, authorize(entries))).toThrow("Invalid ACPX");
  });
  it("admits Cursor through ordinary configuration and ignores unrelated qualification authority", () => {
    const config = { provider: "acpx", acpxAgent: "cursor", model: "exact-cursor-model" };
    vi.stubEnv(ACPX_QUALIFICATION_ENV, JSON.stringify([{ agent: "pi", model: "pi-model" }]));
    expect(resolvePaperclipRunnerProviderProfile(config)).toMatchObject({ acpxAgent: "cursor", model: config.model });
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: config })).toMatchObject({ acpxAgent: "cursor", model: config.model });
    expect(resolveAcpxQualification({ ...provider, agent: "cursor" } as typeof provider, authorize([]))).toBeUndefined();
    expect(() => resolvePaperclipRunnerProviderProfile({ ...config, model: "" })).toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_model_required" }));
  });
  it("does not alter existing qualified providers", () => {
    expect(resolveAcpxQualification({ ...provider, agent: "codex" } as typeof provider, authorize([]))).toBeUndefined();
  });
  it.each(["claude", "codex", "grok", "cursor"])("keeps %s model selection open to native verification", (acpxAgent) => {
    const adapterConfig = { provider: "acpx", acpxAgent, model: "explicit-new-model" };
    expect(resolvePaperclipRunnerProviderProfile(adapterConfig))
      .toMatchObject({ acpxAgent, model: "explicit-new-model" });
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig }))
      .toMatchObject({ acpxAgent, model: "explicit-new-model" });
  });
  it("requires an explicit Codex ACP selection", () => {
    for (const model of [undefined, "", " "]) {
      expect(() => resolvePaperclipRunnerProviderProfile({ provider: "acpx", acpxAgent: "codex", model }))
        .toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_model_unqualified" }));
    }
  });
  it("preserves product defaults separately from qualification examples", () => {
    for (const [acpxAgent, model] of [["claude", "claude-sonnet-5"], ["grok", "grok-4.7"]]) {
      expect(resolvePaperclipRunnerProviderProfile({ provider: "acpx", acpxAgent }))
        .toMatchObject({ acpxAgent, model });
    }
  });
  it("binds the executor to host process environment rather than agent configuration", () => {
    const source = readFileSync(new URL("./native-session-executor.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveAcpxQualification(input.execution.provider, process.env)");
    expect(source).not.toContain("resolveAcpxQualification(input.execution.provider, effectiveRunnerEnvironment)");
  });
});
