import type { Db, agents, heartbeatRuns } from "@paperclipai/db";
import { beforeEach, expect, it, vi } from "vitest";
import { createProviderLimitWait, type ProviderLimitWaitDependencies } from "./provider-limit-wait.js";

const cooldown = vi.hoisted(() => vi.fn());
vi.mock("../native-runtime/native-startup-retry.js", () => ({ agentProviderLimitCooldown: cooldown }));
vi.mock("../../modules/run-dispatch/index.js", () => ({ AI_CONNECTION_POOL_WAIT_RETRY_REASON: "ai_connection_pool_wait" }));

const run = { id: "successor", companyId: "company", agentId: "agent", status: "running", invocationSource: "automation", triggerDetail: "system", scheduledRetryAttempt: 0 } as typeof heartbeatRuns.$inferSelect;
const agent = { id: "agent", companyId: "company", adapterType: "paperclip_runner", runtimeConfig: {} } as typeof agents.$inferSelect;
function fixture() {
  const deps: ProviderLimitWaitDependencies = {
    setRunStatusIfRunning: vi.fn(async () => ({ updated: true, run })),
    setWakeupStatus: vi.fn(async () => undefined), appendRunEvent: vi.fn(async () => undefined),
    scheduleBoundedRetryForRun: vi.fn(async () => ({ outcome: "scheduled" })),
    releaseIssueExecutionAndPromote: vi.fn(async () => undefined), finalizeAgentStatus: vi.fn(async () => undefined),
  };
  return { deps, ...createProviderLimitWait({} as Db, deps) };
}
beforeEach(() => {
  cooldown.mockReset().mockResolvedValue({ resetAt: new Date(Date.now() + 3_600_000), resetReported: false, category: "quota_exhausted", sourceRunId: "source" });
});
it.each([
  { aiConnection: { mode: "router", connectionId: "11111111-1111-4111-8111-111111111111" } },
  { harnessPool: { poolId: "11111111-1111-4111-8111-111111111111" } },
])("lets account-scoped pool routing decide successor availability (%j)", async runtimeConfig => {
  const { deps, deferRunForProviderLimit } = fixture();
  expect(await deferRunForProviderLimit(run, { ...agent, runtimeConfig }, { resumingAdmittedRun: false, conversation: false })).toBe(false);
  expect(cooldown).not.toHaveBeenCalled();
  expect(deps.setRunStatusIfRunning).not.toHaveBeenCalled();
  expect(deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
});
it("keeps the recorded provider wait for direct agents", async () => {
  const { deps, deferRunForProviderLimit } = fixture();
  expect(await deferRunForProviderLimit(run, agent, { resumingAdmittedRun: false, conversation: false })).toBe(true);
  expect(cooldown).toHaveBeenCalledOnce();
  expect(deps.setRunStatusIfRunning).toHaveBeenCalledWith(run.id, "cancelled", expect.objectContaining({ errorCode: "provider_limit_wait", resultJson: expect.objectContaining({ providerLimitWait: expect.objectContaining({ sourceRunId: "source", category: "quota_exhausted" }) }) }));
  expect(deps.scheduleBoundedRetryForRun).toHaveBeenCalledOnce();
  expect(deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
});
