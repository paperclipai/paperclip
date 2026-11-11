import { expect, it } from "vitest";
import { companyPoolSourceAgent } from "./company-pool-execution.js";
import { supportsUnscopedTimerHeartbeat } from "../heartbeat-policy.js";
import { resolveCodexLocalCliPolicy } from "@paperclipai/adapter-codex-local";
import { buildCodexExecArgs } from "../../../../packages/adapters/codex-local/src/server/codex-args.js";
import { applyAiConnectionRouterTaskSettings, assertPoolAdapterPolicyCompatible } from "../ai-connection-router.js";

const agent = {
  adapterType: "paperclip_runner",
  adapterConfig: { provider: "codex", filesystemScope: "workspace", networkScope: "deny", instructionsFilePath: "/saved/instructions.md" },
  runtimeConfig: { harnessPool: { poolId: "00000000-0000-4000-8000-000000000001" } },
};

it("retains the execution restrictions and saved agent while preparing a company harness", () => {
  const saved = structuredClone(agent);
  expect(companyPoolSourceAgent(agent)).toMatchObject({ adapterType: "codex_local",
    adapterConfig: { ...agent.adapterConfig, engine: "cli" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: agent.runtimeConfig.harnessPool.poolId } } });
  expect(agent).toEqual(saved);
});

it.each([{ codexPermissionMode: "on-request" }, { acpxPermissionMode: "approve-paperclip" },
  { acpxPermissionMode: "deny-all" }, { acpxSessionMode: "plan" }, { opencodePermissionMode: "deny" }])(
  "refuses native restrictions that the company harness cannot preserve (%j)", restriction => {
    expect(() => companyPoolSourceAgent({ ...agent, adapterConfig: { ...agent.adapterConfig, ...restriction } }))
      .toThrow("Cannot preserve the configured execution policy");
  });

it("enables unscoped timer wakes for Pool while leaving direct native agents task-bound", () => {
  expect(supportsUnscopedTimerHeartbeat(agent)).toBe(true);
  expect(supportsUnscopedTimerHeartbeat({ adapterType: "paperclip_runner" })).toBe(false);
  expect(supportsUnscopedTimerHeartbeat({ adapterType: "codex_local" })).toBe(true);
});

it("runs ordinary taskless Codex agents with workspace confinement and no sandbox bypass", () => {
  const source = { ...agent, adapterConfig: { provider: "codex" } };
  const saved = structuredClone(source);
  const converted = companyPoolSourceAgent(source);
  expect(converted.adapterConfig).toMatchObject({
    filesystemScope: "workspace",
    dangerouslyBypassApprovalsAndSandbox: false,
    dangerouslyBypassSandbox: false,
  });
  expect(resolveCodexLocalCliPolicy(converted.adapterConfig).bypass).toBe(false);
  const { args } = buildCodexExecArgs(converted.adapterConfig);
  expect(args).toContain('sandbox_mode="workspace-write"');
  expect(args).toContain("sandbox_workspace_write.network_access=false");
  expect(args).not.toContain("sandbox_workspace_write.network_access=true");
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(args).not.toContain("--yolo");
  expect(source).toEqual(saved);
});

it.each([
  { args: ["--yolo"] },
  { extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] },
  { args: ["--sandbox", "danger-full-access"] },
  { extraArgs: ["-c", "sandbox_mode=\"danger-full-access\""] },
  { extraArgs: ["--profile", "unsafe"] },
  { args: ["--add-dir", "/"] },
  { args: "--yolo" },
  { command: "/tmp/custom-codex" },
  { filesystemExtraPaths: [{ path: "/", access: "rw" }] },
  { filesystemSandboxCommand: "/tmp/skip-sandbox" },
])("refuses native-only command settings before they can become active CLI policy (%j)", settings => {
  const source = { ...agent, adapterConfig: { provider: "codex", ...settings } };
  const saved = structuredClone(source);
  expect(() => companyPoolSourceAgent(source)).toThrow("Cannot preserve the configured execution policy");
  expect(source).toEqual(saved);
});

it("retains explicit network restrictions and pins the imposed sandbox against member bypass", () => {
  const converted = companyPoolSourceAgent({ ...agent, adapterConfig: {
    ...agent.adapterConfig, networkScope: "allowlist", networkAllowlist: ["example.org:443"],
    dangerouslyBypassApprovalsAndSandbox: false,
  } });
  expect(converted.adapterConfig).toMatchObject({ networkScope: "allowlist", networkAllowlist: ["example.org:443"] });
  for (const key of ["dangerouslyBypassApprovalsAndSandbox", "dangerouslyBypassSandbox"]) {
    expect(() => assertPoolAdapterPolicyCompatible(converted.adapterConfig, "codex_local", "codex_local", { [key]: true }))
      .toThrow("cannot replace");
  }
  expect(() => assertPoolAdapterPolicyCompatible(converted.adapterConfig, "codex_local", "claude_local", { engine: "cli" }))
    .toThrow("Cannot preserve");
  const effective = applyAiConnectionRouterTaskSettings(converted.adapterConfig, {
    poolId: agent.runtimeConfig.harnessPool.poolId, memberId: "member", adapterType: "codex_local",
    binding: { mode: "delegated", provider: "openai", method: "api_key", connectionId: "connection", grantId: "grant" },
    runtimeConfig: { provider: "codex", model: "gpt-6.1-sol" }, notes: [],
  }, "codex_local", converted.adapterConfig);
  expect(resolveCodexLocalCliPolicy(effective).bypass).toBe(false);
  expect(buildCodexExecArgs(effective).args).toEqual(expect.arrayContaining([
    'sandbox_mode="workspace-write"', "sandbox_workspace_write.network_access=false",
  ]));
  expect(effective).toMatchObject({ filesystemScope: "workspace", networkScope: "allowlist", networkAllowlist: ["example.org:443"] });
});
