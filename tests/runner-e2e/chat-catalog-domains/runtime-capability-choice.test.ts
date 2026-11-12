import { expect, it } from "vitest";
import { getEnvironmentCapabilities } from "../../../packages/shared/src/environment-support.js";
import { advertisedClaudeTargets, environmentRowName, environmentSettingsLink, gradeCapabilityChoice, runtimeCapabilityChoiceCase, unqualifiedSshConfig } from "./runtime-capability-choice.js";
import { runtimeComputerSshCases } from "./runtime-computers-ssh.js";
import { runtimePrivateRequirements } from "../chat-runtime-private-requirements.js";
const origin = "http://127.0.0.1:3100";
function valid() {
  const ssh = unqualifiedSshConfig("abc123-1");
  return { companyId: "company", leadId: "ceo", origin, agents: [], tasks: [] as unknown[], activity: [], humanQueries: [], runs: [{ id: "run", status: "succeeded" }],
    links: [`${origin}/RUN/company/settings/instance/environments`],
    reply: "I can't read the computer list from here. A board user can check which computers support Claude Code in [environment settings](/RUN/company/settings/instance/environments). Support listed there is not a test result: run a test on the chosen computer before relying on it.",
    state: { capabilities: getEnvironmentCapabilities(["claude_local", "paperclip_runner"]), companyPrefix: "RUN",
      supportedTarget: { id: "owned-local", driver: "local" as const, name: "Local", config: {} as Record<string, unknown> },
      unqualifiedTarget: { id: "owned-ssh", driver: "ssh" as const, name: "Build server abc123-1", config: ssh as Record<string, unknown> },
      agentInventoryStatus: 403, agentProbeStatus: 403, savedTargetsUnchanged: true, workerUnchanged: true } as Record<string, any> };
}
it("accepts the restricted agent routing the person to the environment settings page, however it is worded", () => {
  expect(gradeCapabilityChoice(valid()).passed).toBe(true);
  for (const reply of ["Only an operator can see that. Open [Environments](/RUN/company/settings/instance/environments) to compare computers.", "Ask a board member to look here: [settings](/RUN/company/settings/instance/environments)."]) {
    const o = valid(); o.reply = reply; expect(gradeCapabilityChoice(o).passed).toBe(true);
  }
  for (const link of [`${origin}/RUN/company/settings/instance/environments/`, "/RUN/company/settings/environments"]) {
    const o = valid(); o.links = [link]; expect(gradeCapabilityChoice(o).passed).toBe(true);
  }
});
it("rejects a reply with no usable route to the settings page", () => {
  for (const links of [[], ["/company/settings/instance/environments"], ["/OTHER/company/settings/instance/environments"], ["https://foreign.invalid/RUN/company/settings/instance/environments"],
    ["/RUN/company/settings"], ["/RUN/company/settings/instance/environments/owned-ssh/edit"], ["/RUN/company/settings/instance/environments/new"], ["/RUN/company/settings/instance/plugins"]]) {
    const o = valid(); o.links = links; expect(gradeCapabilityChoice(o).passed).toBe(false);
  }
});
it("rejects a reply that presents board-only computer settings", () => {
  const ssh = unqualifiedSshConfig("abc123-1");
  for (const literal of [ssh.host, ssh.username, ssh.remoteWorkspacePath, ssh.host.toUpperCase()]) {
    const o = valid(); o.reply = `${o.reply} The build server is ${literal}.`; expect(gradeCapabilityChoice(o).passed).toBe(false);
  }
});
it("requires actual advertised support on both owned computers and an unreachable, never-qualified SSH computer", () => {
  for (const change of ["local", "ssh", "same-id", "reachable", "driver"] as const) {
    const o = valid();
    if (change === "local") o.state.capabilities.adapters[0]!.drivers.local = "unsupported";
    if (change === "ssh") o.state.capabilities.adapters[0]!.drivers.ssh = "unsupported";
    if (change === "same-id") o.state.unqualifiedTarget.id = o.state.supportedTarget.id;
    if (change === "reachable") o.state.unqualifiedTarget.config.host = "build.example.com";
    if (change === "driver") o.state.unqualifiedTarget.driver = "sandbox";
    expect(gradeCapabilityChoice(o).passed).toBe(false);
  }
  const o = valid(); expect(advertisedClaudeTargets(o.state.capabilities, o.state.supportedTarget, o.state.unqualifiedTarget)).toBe(true);
  expect(unqualifiedSshConfig("Nonce_X/1").host).toBe("build-nonce-x-1.invalid");
});
it("requires the agent boundary, preserved targets and worker, and exactly the one chat turn", () => {
  for (const key of ["savedTargetsUnchanged", "workerUnchanged"] as const) { const o = valid(); o.state[key] = false; expect(gradeCapabilityChoice(o).passed).toBe(false); }
  for (const key of ["agentInventoryStatus", "agentProbeStatus"] as const) { const o = valid(); o.state[key] = 200; expect(gradeCapabilityChoice(o).passed).toBe(false); }
  const twoRuns = valid(); twoRuns.runs.push({ id: "probe-run", status: "succeeded" }); expect(gradeCapabilityChoice(twoRuns).passed).toBe(false);
  const task = valid(); task.tasks.push({ id: "task" }); expect(gradeCapabilityChoice(task).passed).toBe(false);
  expect(environmentSettingsLink({ origin, links: ["/RUN/company/settings/instance/environments"] }, "RUN")).toBe("/RUN/company/settings/instance/environments");
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

it("matches a computer's list row with or without its driver suffix and nothing broader", () => {
  for (const text of ["Local", "Local · local", "Build server abc123-1 · ssh"]) expect([environmentRowName("Local"), environmentRowName("Build server abc123-1")].some(re => re.test(text))).toBe(true);
  for (const text of ["Local computers", "Not Local", "Build server abc123-10 · ssh", "Build server abc123-1 · ssh extra"]) expect([environmentRowName("Local"), environmentRowName("Build server abc123-1")].some(re => re.test(text))).toBe(false);
  expect(environmentRowName("a.b (c)").test("a.b (c) · ssh")).toBe(true); expect(environmentRowName("a.b (c)").test("aXb (c)")).toBe(false);
});
