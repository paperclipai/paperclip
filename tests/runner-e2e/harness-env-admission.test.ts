import { afterEach, expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";

const profilesModule = "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
const copilot = runnerMatrix.find(cell => cell.suite.id === "extended-harnesses" && cell.profile.qualificationCandidate === "copilot")!;
afterEach(() => { vi.doUnmock(profilesModule); vi.resetModules(); });

it("uses normal production admission for the current qualified Copilot profile", async () => {
  expect(QUALIFIED_ACPX_PROFILES.copilot.qualificationStatus).toBeUndefined();
  const { buildRunnerE2EProcessEnvironment } = await import("./harness-env.js");
  expect(buildRunnerE2EProcessEnvironment({ PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" }, [copilot])
    .PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
});

it("retains exact, explicit admission when a future profile is pending", async () => {
  const actual = await vi.importActual<typeof import("../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js")>(profilesModule);
  vi.doMock(profilesModule, () => ({ ...actual, QUALIFIED_ACPX_PROFILES: { ...actual.QUALIFIED_ACPX_PROFILES,
    copilot: { ...actual.QUALIFIED_ACPX_PROFILES.copilot, qualificationStatus: "pending" } } }));
  vi.resetModules();
  const { buildRunnerE2EProcessEnvironment } = await import("./harness-env.js");
  const env = buildRunnerE2EProcessEnvironment({ PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" }, [copilot]);
  expect(JSON.parse(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent: "copilot", model: copilot.profile.model }]);
  expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...copilot, suite: { ...copilot.suite, manualOnly: false } }])).toThrow("explicit");
  expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...copilot, suite: { ...copilot.suite, id: "unrelated-suite" } }])).toThrow("explicit");
  expect(() => buildRunnerE2EProcessEnvironment({}, [copilot, { ...copilot, profile: { ...copilot.profile, model: "conflicting-model" } }])).toThrow("Conflicting");
});

it("strips ambient candidate startup records and never authorizes pending Kimi through the old model allowlist", async () => {
  const { buildRunnerE2EProcessEnvironment, buildPaperclipServerEnvironment } = await import("./harness-env.js");
  const kimi = runnerMatrix.find(row => row.suite.id === "kimi-qualification")!;
  const ambient = { PAPERCLIP_ACPX_CANDIDATE_ADMISSION: "forged", PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "forged" };
  const env = buildRunnerE2EProcessEnvironment(ambient, [kimi]);
  expect(env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION).toBeUndefined();
  expect(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
  expect(buildPaperclipServerEnvironment(ambient).PAPERCLIP_ACPX_CANDIDATE_ADMISSION).toBeUndefined();
});
