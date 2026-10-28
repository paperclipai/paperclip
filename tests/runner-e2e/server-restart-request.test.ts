import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { controllerOutageForExecution } from "./controller-outage.js";
import { readRestartRequest } from "./server-restart-request.js";

let root: string;
let requestPath: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paperclip-supervisor-request-"));
  requestPath = join(root, "restart.json");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

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
