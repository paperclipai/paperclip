import { describe, expect, it } from "vitest";
import { pendingAgentSetupChoice, pendingAgentSetupDisplayAdapter } from "./agent-setup-choice";

const choice = { adapterType: "paperclip_runner", runnerProvider: "antigravity", runner: "auto" } as const;
describe("held agent setup choice", () => {
  it("retains only the recognized display and navigation intent", () => {
    const draft = { pauseReason: "setup", metadata: { setupAdapterPending: true, setupAdapterChoice: { ...choice, env: "must not project" } } };
    expect(pendingAgentSetupChoice(draft)).toEqual(choice);
    expect(pendingAgentSetupDisplayAdapter(draft)).toBe("antigravity_runtime");
  });
  it.each([
    { pauseReason: null, metadata: { setupAdapterPending: true, setupAdapterChoice: choice } },
    { pauseReason: "setup", metadata: { setupAdapterPending: false, setupAdapterChoice: choice } },
    { pauseReason: "setup", metadata: { setupAdapterPending: true, setupAdapterChoice: { ...choice, runnerProvider: "unknown" } } },
  ])("does not override an active or unrecognized agent ($pauseReason)", draft => {
    expect(pendingAgentSetupChoice(draft)).toBeUndefined();
    expect(pendingAgentSetupDisplayAdapter(draft)).toBeUndefined();
  });
});

it("retains a held Pool choice without treating it as execution authority", () => {
  const choice = { adapterType: "paperclip_runner", runnerProvider: "pool", runner: "auto" };
  const draft = { pauseReason: "setup", metadata: { setupAdapterPending: true, setupAdapterChoice: choice } };
  expect(pendingAgentSetupChoice(draft)).toEqual(choice);
  expect(pendingAgentSetupDisplayAdapter(draft)).toBe("pool");
});
