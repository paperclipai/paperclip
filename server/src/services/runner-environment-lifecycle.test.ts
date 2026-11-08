import {expect,it} from "vitest";
import {resolveRunnerEnvironmentForRun,resolveWarmRunnerIdleTimeoutMsForRun} from "./runner-environment-lifecycle.js";

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

it.each([
  [{ provider: "codex" }, true], [{ provider: "opencode" }, true], [{ provider: "acpx", acpxAgent: "claude" }, true],
  [{ provider: "acpx", acpxAgent: "grok" }, false], [{ provider: "codex", lifecycleMode: "per_turn" }, false], [{}, false],
] as const)("defaults a measured harness on an inheriting sandbox environment to a reusable warm sandbox: %j", (adapterConfig, warm) => {
  const sandbox = { driver: "sandbox" as const, config: { provider: "daytona", reuseLease: false } };
  const resolved = resolveRunnerEnvironmentForRun(sandbox, "paperclip_runner", adapterConfig);
  expect(resolved.config.reuseLease).toBe(warm);
  expect(resolveWarmRunnerIdleTimeoutMsForRun(sandbox, "paperclip_runner", adapterConfig)).toBe(warm ? 300_000 : undefined);
  // The shared environment itself is never rewritten.
  expect(sandbox.config.reuseLease).toBe(false);
});
it("keeps an environment that pins per-turn, and an admitted per-turn recovery, per-turn", () => {
  const pinned = { driver: "sandbox" as const, config: { provider: "daytona", runnerLifecycleMode: "per_turn" } };
  expect(resolveRunnerEnvironmentForRun(pinned, "paperclip_runner", { provider: "codex" })).toBe(pinned);
  const inheriting = { driver: "sandbox" as const, config: { provider: "daytona" } };
  expect(resolveRunnerEnvironmentForRun(inheriting, "paperclip_runner", { provider: "codex" }, "per_turn")).toBe(inheriting);
});
