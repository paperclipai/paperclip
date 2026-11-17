import {describe,expect,it} from "vitest";
import {resolveRunnerEnvironmentForRun,resolveWarmRunnerIdleTimeoutMsForRun,runnerLifecycleDefaultNeedsLeaseProbe} from "./runner-environment-lifecycle.js";

it.each([undefined,"codex","acpx","opencode"])("defaults plugin Runner execution to warm without provider gates: %s",provider=>{
 const environment={driver:"plugin" as const,config:{pluginKey:"fixture",driverKey:"tasks",driverConfig:{}}};
 expect(resolveRunnerEnvironmentForRun(environment,"paperclip_runner",{provider,idleTimeoutMs:1234},undefined,"selected-account:generation")).toMatchObject({config:{runnerLifecycleMode:"warm",runnerIdleTimeoutMs:1234}});
 expect(environment.config).not.toHaveProperty("runnerLifecycleMode");
});
it("keeps plugin-owned credentials per-turn without changing admitted recovery",()=>{
 const environment={driver:"plugin" as const,config:{pluginKey:"fixture",driverKey:"tasks",driverConfig:{},runnerLifecycleMode:"warm"}};
 expect(resolveRunnerEnvironmentForRun(environment,"paperclip_runner",{lifecycleMode:"warm"})).toMatchObject({config:{runnerLifecycleMode:"per_turn"}});
 expect(resolveRunnerEnvironmentForRun(environment,"paperclip_runner",{},"warm")).toMatchObject({config:{runnerLifecycleMode:"warm"}});
});
it("preserves explicit per-turn settings and the admitted recovery policy",()=>{
 const environment={driver:"plugin" as const,config:{pluginKey:"fixture",driverKey:"tasks",driverConfig:{}}};
 expect(resolveRunnerEnvironmentForRun(environment,"paperclip_runner",{lifecycleMode:"per_turn"},undefined,"account:generation")).toMatchObject({config:{runnerLifecycleMode:"per_turn"}});
 expect(resolveRunnerEnvironmentForRun(environment,"paperclip_runner",{},"per_turn")).toMatchObject({config:{runnerLifecycleMode:"per_turn"}});
 expect(resolveRunnerEnvironmentForRun({...environment,config:{...environment.config,runnerLifecycleMode:"per_turn"}},"paperclip_runner",{lifecycleMode:"warm"},undefined,"account:generation")).toMatchObject({config:{runnerLifecycleMode:"per_turn"}});
 expect(resolveRunnerEnvironmentForRun(environment,"claude_local",{})).toBe(environment);
});
it("forwards the run's warm idle window for a warm sandbox-provider run only",()=>{
 const sandbox={driver:"sandbox" as const,config:{provider:"daytona",reuseLease:true}};
 // Agent-level warm with an inherited environment lifecycle: the provider must see the agent's window.
 expect(resolveWarmRunnerIdleTimeoutMsForRun(sandbox,"paperclip_runner",{lifecycleMode:"warm",idleTimeoutMs:900_000})).toBe(900_000);
 // The environment's own window wins over the agent's.
 expect(resolveWarmRunnerIdleTimeoutMsForRun({...sandbox,config:{...sandbox.config,runnerLifecycleMode:"warm",runnerIdleTimeoutMs:600_000}},"paperclip_runner",{idleTimeoutMs:900_000})).toBe(600_000);
 expect(resolveWarmRunnerIdleTimeoutMsForRun(sandbox,"paperclip_runner",{},"warm")).toBe(300_000);
 expect(resolveWarmRunnerIdleTimeoutMsForRun(sandbox,"paperclip_runner",{lifecycleMode:"per_turn",idleTimeoutMs:900_000})).toBeUndefined();
 expect(resolveWarmRunnerIdleTimeoutMsForRun({...sandbox,config:{...sandbox.config,runnerLifecycleMode:"per_turn"}},"paperclip_runner",{lifecycleMode:"warm"})).toBeUndefined();
 expect(resolveWarmRunnerIdleTimeoutMsForRun(sandbox,"claude_local",{lifecycleMode:"warm"})).toBeUndefined();
 expect(resolveWarmRunnerIdleTimeoutMsForRun({driver:"plugin" as const,config:{}},"paperclip_runner",{lifecycleMode:"warm"})).toBeUndefined();
});

describe("remote-sandbox warm default", () => {
  const inheriting = { driver: "sandbox" as const, config: { provider: "daytona", reuseLease: false } };
  const supported = { reusableLeaseSupported: true };
  const opencode = { provider: "opencode", model: "openai/gpt-5" };
  const claude = { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-4-6" };

  it.each([
    ["Codex", { provider: "codex" }, true],
    // Rule 3: an omitted provider resolves to Codex, as the runtime resolves it.
    ["an omitted provider (Codex)", {}, true],
    ["OpenCode", opencode, true],
    ["ACPX Claude", claude, true],
    ["an unmeasured ACPX harness", { provider: "acpx", acpxAgent: "grok", model: "grok-4" }, false],
    ["a config the runtime refuses", { provider: "opencode" }, false],
  ] as const)("%s on a provider with reusable leases: warm=%s", (_name, adapterConfig, warm) => {
    const resolved = resolveRunnerEnvironmentForRun(inheriting, "paperclip_runner", adapterConfig, undefined, undefined, supported);
    expect(resolved.config.reuseLease).toBe(warm);
    expect(resolveWarmRunnerIdleTimeoutMsForRun(inheriting, "paperclip_runner", adapterConfig, undefined, supported))
      .toBe(warm ? 300_000 : undefined);
    expect(runnerLifecycleDefaultNeedsLeaseProbe(inheriting, "paperclip_runner", adapterConfig)).toBe(warm);
    // The shared environment itself is never rewritten.
    expect(inheriting.config.reuseLease).toBe(false);
  });

  // Rule 1: a provider without reusable leases (E2B, Modal, fake) keeps master's per-turn behavior.
  it.each([{ provider: "codex" }, {}, claude])("keeps %j per-turn on a provider without reusable leases", (adapterConfig) => {
    for (const context of [{}, { reusableLeaseSupported: false }]) {
      expect(resolveRunnerEnvironmentForRun(inheriting, "paperclip_runner", adapterConfig, undefined, undefined, context)).toBe(inheriting);
      expect(resolveWarmRunnerIdleTimeoutMsForRun(inheriting, "paperclip_runner", adapterConfig, undefined, context)).toBeUndefined();
    }
  });

  // Rule 2: explicit configuration wins and needs no probe.
  it("honors explicit lifecycles and the configured idle window", () => {
    const pinned = { driver: "sandbox" as const, config: { provider: "daytona", runnerLifecycleMode: "per_turn" } };
    expect(resolveRunnerEnvironmentForRun(pinned, "paperclip_runner", { provider: "codex" }, undefined, undefined, supported)).toBe(pinned);
    expect(runnerLifecycleDefaultNeedsLeaseProbe(pinned, "paperclip_runner", { provider: "codex" })).toBe(false);
    expect(resolveRunnerEnvironmentForRun(inheriting, "paperclip_runner", { provider: "codex", lifecycleMode: "per_turn" }, undefined, undefined, supported)).toBe(inheriting);
    expect(runnerLifecycleDefaultNeedsLeaseProbe(inheriting, "paperclip_runner", { lifecycleMode: "per_turn" })).toBe(false);
    expect(resolveRunnerEnvironmentForRun(inheriting, "paperclip_runner", { provider: "codex" }, "per_turn", undefined, supported)).toBe(inheriting);
    expect(runnerLifecycleDefaultNeedsLeaseProbe(inheriting, "paperclip_runner", {}, "per_turn")).toBe(false);
    expect(resolveWarmRunnerIdleTimeoutMsForRun(inheriting, "paperclip_runner", { idleTimeoutMs: 900_000 }, undefined, supported)).toBe(900_000);
    expect(resolveWarmRunnerIdleTimeoutMsForRun({ ...inheriting, config: { ...inheriting.config, runnerIdleTimeoutMs: 600_000 } },
      "paperclip_runner", { idleTimeoutMs: 900_000 }, undefined, supported)).toBe(600_000);
  });

  // Rule 2: a managed AI account without a warm session gets no default; managed Codex supports one.
  it("defaults managed AI runs only when the harness supports a managed warm session", () => {
    expect(resolveRunnerEnvironmentForRun(inheriting, "paperclip_runner", claude, undefined, "account:generation", supported)).toBe(inheriting);
    expect(runnerLifecycleDefaultNeedsLeaseProbe(inheriting, "paperclip_runner", claude, undefined, "account:generation")).toBe(false);
    expect(resolveWarmRunnerIdleTimeoutMsForRun(inheriting, "paperclip_runner", claude, undefined,
      { ...supported, managedAiCredentialIdentity: "account:generation" })).toBeUndefined();
    expect(resolveRunnerEnvironmentForRun(inheriting, "paperclip_runner", {}, undefined, "account:generation", supported).config.reuseLease).toBe(true);
  });

  it("never applies to plugin tasks or other adapters", () => {
    expect(runnerLifecycleDefaultNeedsLeaseProbe({ driver: "plugin", config: {} }, "paperclip_runner", {})).toBe(false);
    expect(runnerLifecycleDefaultNeedsLeaseProbe(inheriting, "codex_local", {})).toBe(false);
    expect(resolveRunnerEnvironmentForRun(inheriting, "codex_local", {}, undefined, undefined, supported)).toBe(inheriting);
  });
});

