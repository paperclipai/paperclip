import {expect,it} from "vitest";
import {resolveRunnerEnvironmentForRun} from "./runner-environment-lifecycle.js";

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
