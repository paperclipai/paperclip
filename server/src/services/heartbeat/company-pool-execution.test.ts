import { expect, it } from "vitest";
import { companyPoolSourceAgent } from "./company-pool-execution.js";
import { supportsUnscopedTimerHeartbeat } from "../heartbeat-policy.js";

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
