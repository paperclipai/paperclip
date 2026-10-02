import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ACPX_QUALIFICATION_ENV, resolveAcpxQualification } from "./acpx-qualification.js";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerProviderProfile, resolvePaperclipRunnerNativeProviderInput } from "./provider-profile.js";

const provider = { kind: "acpx", agent: "cursor", model: "exact-model", permissionMode: "approve-all" } as NativeExecutionInput["provider"];
const authorize = (value: unknown) => ({ [ACPX_QUALIFICATION_ENV]: JSON.stringify(value) });
describe("host ACPX qualification admission", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(["cursor", "copilot"])("admits %s through agent validation and native input only for the exact host pair", (agent) => {
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
  it("admits only the exact Pi model without host authorization and preserves permission modes", () => {
    const config = { provider: "acpx", acpxAgent: "pi", model: "openrouter/deepseek/deepseek-v4-flash-0731" };
    for (const authorization of [undefined, "malformed unrelated candidate authorization"]) {
      vi.stubEnv(ACPX_QUALIFICATION_ENV, authorization);
      expect(resolvePaperclipRunnerProviderProfile(config)).toMatchObject(config);
      for (const acpxPermissionMode of [undefined, "approve-all", "approve-paperclip", "approve-reads", "deny-all"]) {
        expect(resolvePaperclipRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: { ...config, acpxPermissionMode } }))
          .toMatchObject({ ...config, acpxPermissionMode: acpxPermissionMode ?? "approve-all" });
      }
      for (const model of [undefined, "", "different-model"]) {
        expect(() => resolvePaperclipRunnerProviderProfile({ ...config, model }))
          .toThrow(expect.objectContaining({ code: "paperclip_runner_acpx_model_unqualified" }));
      }
    }
  });
  it("keeps normal candidate execution closed and admits only the exact operator pair", () => {
    expect(resolveAcpxQualification(provider, {})).toBeUndefined();
    expect(resolveAcpxQualification(provider, authorize([{ agent: "cursor", model: "exact-model" }]))).toBe("cursor");
    for (const entries of [[{ agent: "copilot", model: "exact-model" }], [{ agent: "cursor", model: "other-model" }]]) {
      expect(() => resolveAcpxQualification(provider, authorize(entries))).toThrow("exact model");
    }
  });
  it.each([[], {}, [{ agent: "cursor", model: "" }], [{ agent: "cursor", model: " exact-model" }],
    [{ agent: "cursor", model: "exact-model", allowAll: true }], [{ agent: "claude", model: "exact-model" }],
    [{ agent: "cursor", model: "exact-model" }, { agent: "cursor", model: "exact-model" }],
  ])("rejects malformed or broad authorization %j", entries => {
    expect(() => resolveAcpxQualification(provider, authorize(entries))).toThrow("Invalid ACPX");
  });
  it("does not alter existing qualified providers", () => {
    expect(resolveAcpxQualification({ ...provider, agent: "codex" } as typeof provider, authorize([]))).toBeUndefined();
  });
  it("binds the executor to host process environment rather than agent configuration", () => {
    const source = readFileSync(new URL("./native-session-executor.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveAcpxQualification(input.execution.provider, process.env)");
    expect(source).not.toContain("resolveAcpxQualification(input.execution.provider, effectiveRunnerEnvironment)");
  });
});
