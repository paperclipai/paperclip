import { expect, it } from "vitest";
import { getEnvironmentCapabilities } from "../../../packages/shared/src/environment-support.js";
import { advertisedClaudeTargets, capabilityChoiceReply, recommendsIncompatibleTarget, gradeCapabilityChoice, runtimeCapabilityChoiceCase } from "./runtime-capability-choice.js";
import { runtimeComputerSshCases } from "./runtime-computers-ssh.js";
import { runtimePrivateRequirements } from "../chat-runtime-private-requirements.js";
function valid() {
  return { companyId: "company", leadId: "ceo", agents: [], tasks: [], activity: [], links: [], humanQueries: [], runs: [{ id: "run", status: "succeeded" }],
    reply: "An operator can open environment settings to inspect Claude Code capability support. Advertised compatibility does not establish runtime health; test the selected target before calling it ready.",
    state: { capabilities: getEnvironmentCapabilities(["claude_local", "paperclip_runner"]), supportedTarget: { id: "owned-local", driver: "local" as const, name: "Local", config: {} }, unsupportedTarget: { id: "owned-control", driver: "sandbox" as const, name: "Control", config: { provider: "fake" } }, agentInventoryStatus: 403, agentProbeStatus: 403, operatorViewVisible: true, viewCapabilitiesMatched: true, savedTargetsUnchanged: true, workerUnchanged: true } };
}
it("accepts actual declared capability contrast without an account, secret, or remote health probe", () => {
  expect(gradeCapabilityChoice(valid()).passed).toBe(true);
  expect(capabilityChoiceReply("Ask the board administrator to open the computer settings and check Claude Code support. A compatible computer still needs runtime health validation before use.")).toBe(true);
});
it("rejects false health, hidden inventory and generic advice", () => {
  for (const reply of ["The operator settings show Claude Code support and the computer is fully ready; health testing passed.", "I inspected the hidden inventory. Ask an operator about Claude Code capability and health tests.", "Ask the operator.", "The operator must inspect Claude Code capability settings and the computer is fully ready for health testing."]) {
    const o = valid(); o.reply = reply; expect(gradeCapabilityChoice(o).passed).toBe(false);
  }
});
it("rejects unsupported-as-ready, wrong resource and invented capability metadata", () => {
  for (const change of ["support", "same-id", "supported-control"] as const) {
    const o = valid();
    if (change === "support") o.state.capabilities.adapters[0]!.drivers.local = "unsupported";
    if (change === "same-id") o.state.unsupportedTarget.id = o.state.supportedTarget.id;
    if (change === "supported-control") o.state.capabilities.adapters[0]!.sandboxProviders.fake = "supported";
    expect(gradeCapabilityChoice(o).passed).toBe(false);
  }
  const o = valid(); expect(advertisedClaudeTargets(o.state.capabilities, { ...o.state.supportedTarget, driver: "ssh" }, o.state.unsupportedTarget)).toBe(false);
});
it("requires real route/resource observation and preserved worker configuration", () => {
  for (const key of ["operatorViewVisible", "viewCapabilitiesMatched", "savedTargetsUnchanged", "workerUnchanged"] as const) { const o = valid(); o.state[key] = false; expect(gradeCapabilityChoice(o).passed).toBe(false); }
  const o = valid(); o.state.agentInventoryStatus = 200; expect(gradeCapabilityChoice(o).passed).toBe(false);
});
it("removes only the choice case private contract and preserves both genuine SSH journeys", () => {
  expect(runtimeCapabilityChoiceCase.externalInput).toBeUndefined(); expect(runtimeCapabilityChoiceCase.requiredCredentials).toBeUndefined();
  expect(runtimeCapabilityChoiceCase.expectedRunCount).toBe(1); expect(runtimeCapabilityChoiceCase.attemptTimeoutMs).toBe(900000);
  expect(runtimePrivateRequirements).not.toHaveProperty("execution-environments.choose-capable-target");
  for (const id of ["execution-environments.add-computer", "execution-environments.test-computer"]) {
    expect(runtimeComputerSshCases.find(row => row.scenarioId === id)?.externalInput?.provider).toBe("ssh");
    expect(runtimePrivateRequirements).toHaveProperty(id);
  }
});

it("rejects a recommendation of the incompatible target despite otherwise truthful capability advice", () => {
  const o = valid(); o.reply = "Choose the incompatible target for Morgan with Claude Code. The operator settings explain capability support; runtime health still needs testing.";
  expect(gradeCapabilityChoice(o).passed).toBe(false);
  for (const text of ["Select the unsupported computer.", "Use an incompatible target.", "The unsupported environment is the recommended choice."]) expect(recommendsIncompatibleTarget(text)).toBe(true);
  for (const text of ["Do not choose the incompatible target.", "Never select an unsupported computer.", "If a target is incompatible, choose another computer.", "Selecting an incompatible computer would fail; ask the operator to inspect supported capabilities."]) expect(recommendsIncompatibleTarget(text)).toBe(false);
});

it("distinguishes using a capability view to reject targets from choosing those targets", () => {
  const o = valid(); o.reply = "An operator can use the capability view to rule out unsupported targets. Claude Code support does not establish runtime health; test before use.";
  expect(gradeCapabilityChoice(o).passed).toBe(true);
  o.reply = "Use the unsupported computer for Claude Code. The operator capability settings show support; runtime health still needs testing.";
  expect(gradeCapabilityChoice(o).passed).toBe(false);
});
