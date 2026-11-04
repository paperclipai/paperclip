import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { controllerOutageForExecution } from "./controller-outage.js";
import { readRestartRequest, kimiCandidateAdmissionForExecution } from "./server-restart-request.js";

let root: string;
let requestPath: string;
const profilesModule = "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paperclip-supervisor-request-"));
  requestPath = join(root, "restart.json");
});
afterEach(async () => {
  vi.doUnmock(profilesModule);
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

const cells = ["everyday-workflows", "daytona-restart-continuity"].flatMap(suite =>
  ["codex", "acpx"].map(provider => {
    const execution = runnerMatrix.find(row => row.suite.id === suite && row.task.id === "recover-controller"
      && row.environment.id === "daytona" && row.profile.generation === "native" && row.profile.provider === provider);
    if (!execution) throw new Error(`Missing real ${suite}/${provider} continuity cell`);
    return execution;
  }));

it.each(cells)("accepts the real supervisor request file for $id", async execution => {
  const outage = controllerOutageForExecution(execution, {})!;
  await writeFile(requestPath, JSON.stringify({ requestId: "actual-restart-request",
    discardControllerCache: true, controllerOutage: outage }));
  await expect(readRestartRequest(requestPath, [execution.id])).resolves.toMatchObject({
    requestId: "actual-restart-request", discardControllerCache: true, controllerOutage: outage,
  });
});

it("rejects cache replacement for unselected, local and legacy cells", async () => {
  await writeFile(requestPath, JSON.stringify({ requestId: "unsupported-restart", discardControllerCache: true }));
  const local = runnerMatrix.find(row => row.environment.id === "local")!;
  const legacy = runnerMatrix.find(row => row.profile.generation === "legacy")!;
  expect(local).toBeDefined(); expect(legacy).toBeDefined();
  for (const ids of [[], ["not-a-cell"], [local.id], [legacy.id]]) {
    await expect(readRestartRequest(requestPath, ids)).rejects.toThrow(/cache replacement requires/i);
  }
});

it.each([
  { controllerOutage: { signal: "SIGKILL", holdMs: 125_000 }, discardControllerCache: false },
  { controllerOutage: { signal: "SIGKILL", holdMs: 300_001 }, discardControllerCache: true },
  { controllerOutage: { signal: "SIGKILL", holdMs: 125_000 }, discardControllerCache: true, preserveRunner: {} },
  { controllerOutage: { signal: "SIGKILL", holdMs: 125_000 }, discardControllerCache: true, crashAfterResult: {} },
  { recoveryBinding: {} },
  { controllerDowntimeMs: -1 },
])("keeps invalid and conflicting fault boundaries rejected: %j", async fault => {
  await writeFile(requestPath, JSON.stringify({ requestId: "conflicting-restart", ...fault }));
  await expect(readRestartRequest(requestPath, [cells[0].id])).rejects.toThrow();
});

it("ignores absent and incomplete atomic request files", async () => {
  await expect(readRestartRequest(requestPath, [cells[0].id])).resolves.toBeNull();
  await writeFile(requestPath, "{");
  await expect(readRestartRequest(requestPath, [cells[0].id])).resolves.toBeNull();
});

it.each(["local", "daytona"])("uses ordinary released Kimi restart without candidate authority on %s", async environment => {
  const execution = runnerMatrix.find(row => row.suite.id === "kimi-qualification" && row.environment.id === environment)!;
  const admission = kimiCandidateAdmissionForExecution(execution, "11111111-1111-4111-8111-111111111111");
  expect(admission).toBeUndefined();
  await writeFile(requestPath, JSON.stringify({ requestId: "kimi-released", kimiCandidateAdmission: admission }));
  const request = await readRestartRequest(requestPath, [execution.id]);
  expect(request).toMatchObject({ requestId: "kimi-released" });
  expect(request).not.toHaveProperty("kimiCandidateAdmission");
});

it.each(["local", "daytona"])("stages only exact pending Kimi company/model/profile/target via owned restart on %s", async environment => {
  const actual = await vi.importActual<typeof import("../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js")>(profilesModule);
  vi.doMock(profilesModule, () => ({ ...actual, QUALIFIED_ACPX_PROFILES: { ...actual.QUALIFIED_ACPX_PROFILES,
    kimi: { ...actual.QUALIFIED_ACPX_PROFILES.kimi, qualificationStatus: "pending" } } }));
  vi.resetModules();
  const { readRestartRequest, kimiCandidateAdmissionForExecution } = await import("./server-restart-request.js");
  const execution = runnerMatrix.find(row => row.suite.id === "kimi-qualification" && row.environment.id === environment)!;
  const admission = kimiCandidateAdmissionForExecution(execution, "11111111-1111-4111-8111-111111111111")!;
  expect(admission).toBeDefined();
  await writeFile(requestPath, JSON.stringify({ requestId: "kimi-startup", kimiCandidateAdmission: admission }));
  await expect(readRestartRequest(requestPath, [execution.id])).resolves.toMatchObject({ requestId: "kimi-startup", kimiCandidateAdmission: admission });
  expect(admission).not.toHaveProperty("runId");
  for (const change of [{ companyId: "foreign" }, { agent: "antigravity" }, { model: "different" },
    { profileDigest: `sha256:${"0".repeat(64)}` }, { nativeClosureDigest: `sha256:${"0".repeat(64)}` },
    { expiresAt: 0 }, { runId: "injected-run" }, { architecture: "arm64", platform: "linux" }]) {
    await writeFile(requestPath, JSON.stringify({ requestId: "wrong-kimi", kimiCandidateAdmission: { ...admission, ...change } }));
    await expect(readRestartRequest(requestPath, [execution.id])).rejects.toThrow();
  }
  await writeFile(requestPath, JSON.stringify({ requestId: "unselected-kimi", kimiCandidateAdmission: admission }));
  for (const ids of [[], [cells[0].id]]) await expect(readRestartRequest(requestPath, ids)).rejects.toThrow();
  for (const change of [{ controllerDowntimeMs: 1 }, { preserveRunner: {} }, { discardControllerCache: true }]) {
    await writeFile(requestPath, JSON.stringify({ requestId: "mixed-kimi", kimiCandidateAdmission: admission, ...change }));
    await expect(readRestartRequest(requestPath, [execution.id])).rejects.toThrow();
  }
});
