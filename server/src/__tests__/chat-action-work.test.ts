import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerChatActionWork } from "../services/chat-action-work.js";
import { CHAT_ACTION_QUEUES, notifyChatActionWork, notifyChatEndpointWork, notifyChatVerificationWork } from "../services/chat-work-notifications.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.stop();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  const execute = vi.fn(async () => [{ xid: "42", status: "committed" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(callback: (tx: any) => Promise<any>) {
    return callback({ execute });
  } });
  const enabled = vi.fn(() => true), onError = vi.fn();
  const coordinator = createDeliveryWorkCoordinator({ owner, canRun: enabled, canReconcile: enabled, onError });
  coordinators.push(coordinator);
  const service = {
    processPendingProviderEffects: vi.fn(async () => {}),
    processPendingGitHubWebhookIngress: vi.fn(async () => {}),
    processPendingSlackSessionSyncs: vi.fn(async () => {}),
    processPendingSlackBoardMessages: vi.fn(async () => {}),
    processPendingSlackTaskStarts: vi.fn(async () => {}),
    processPendingReceiptReactions: vi.fn(async () => {}),
    processPendingSlackSessionStops: vi.fn(async () => {}),
    processPendingVerificationMessages: vi.fn(async () => {}),
    nextChatActionAt: vi.fn(async (): Promise<number | null> => null),
    nextVerificationMessageAt: vi.fn(async (): Promise<number | null> => null),
  };
  const runs = [service.processPendingProviderEffects, service.processPendingGitHubWebhookIngress, service.processPendingSlackSessionSyncs, service.processPendingSlackBoardMessages, service.processPendingSlackTaskStarts,
    service.processPendingReceiptReactions, service.processPendingSlackSessionStops, service.processPendingVerificationMessages];
  return { owner, service, runs, coordinator, enabled, onError, start: () => registerChatActionWork(coordinator, service, enabled) };
}
describe("chat action scheduling", () => {
  it("does one startup scan per lane and no more SQL or timers during an idle hour", async () => {
    const s = setup();
    await s.start().ready;
    await vi.advanceTimersByTimeAsync(3_600_000);
    for (const run of s.runs) expect(run).toHaveBeenCalledTimes(1);
    expect(s.service.nextChatActionAt).toHaveBeenCalledTimes(7);
    expect(s.service.nextVerificationMessageAt).toHaveBeenCalledTimes(1);
    expect(s.coordinator.nextWakeAt()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("wakes each lane after its write settles and wakes parked work when an endpoint changes", async () => {
    const s = setup();
    await s.start().ready;
    for (const kind of Object.keys(CHAT_ACTION_QUEUES) as (keyof typeof CHAT_ACTION_QUEUES)[]) {
      await s.owner.transaction(async tx => {
        await notifyChatActionWork(tx, kind);
        expect(s.runs.every(run => run.mock.calls.length === 1)).toBe(true);
      });
    }
    await s.owner.transaction(tx => notifyChatVerificationWork(tx));
    await vi.advanceTimersByTimeAsync(1);
    for (const run of s.runs) expect(run).toHaveBeenCalledTimes(2);
    await s.owner.transaction(tx => notifyChatEndpointWork(tx));
    await vi.advanceTimersByTimeAsync(1);
    for (const run of s.runs) expect(run).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("restores durable deadlines and reschedules when a foreground send moves a retry earlier", async () => {
    const s = setup();
    let due: number | null = Date.now() + 120_000;
    s.service.nextChatActionAt.mockImplementation(async () => due);
    await s.start().ready;
    expect(s.coordinator.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(1000);
    due = Date.now() + 30_000;
    await s.owner.transaction(tx => notifyChatActionWork(tx, "receipt_reaction"));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.coordinator.nextWakeAt()).toBe(due);
    expect(s.service.processPendingReceiptReactions).toHaveBeenCalledTimes(2);
    due = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.service.processPendingReceiptReactions).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });
  it("keeps lanes independent and retains a commit received during a drain", async () => {
    const s = setup();
    let release!: () => void;
    s.service.processPendingSlackBoardMessages.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const work = s.start();
    await vi.advanceTimersByTimeAsync(1);
    await s.owner.transaction(tx => notifyChatActionWork(tx, "slack_board_message"));
    await s.owner.transaction(tx => notifyChatActionWork(tx, "slack_session_stop"));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.processPendingSlackSessionStops).toHaveBeenCalledTimes(2);
    release(); await work.ready;
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.processPendingSlackBoardMessages).toHaveBeenCalledTimes(2);
  });
  it("retries failed recovery and does no dispatch or deadline queries during standby", async () => {
    const s = setup();
    s.enabled.mockReturnValue(false);
    await s.start().ready;
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.service.nextChatActionAt).not.toHaveBeenCalled();
    for (const run of s.runs) expect(run).not.toHaveBeenCalled();
    s.enabled.mockReturnValue(true);
    s.service.processPendingSlackTaskStarts.mockRejectedValueOnce(new Error("DB unavailable"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.service.processPendingSlackTaskStarts).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
