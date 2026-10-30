import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerRoutineExecutionStatusWork } from "../services/routine-execution-status-work.js";

let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
let canRun = true;
const errors: unknown[] = [];
const entry = { id: "run", companyId: "company", routineId: "routine", issueId: "issue" };
beforeEach(() => {
  vi.useFakeTimers(); canRun = true; errors.length = 0;
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => canRun, canReconcile: () => true,
    onError: error => errors.push(error) });
});
afterEach(async () => { await coordinator.stop(); vi.useRealTimers(); });

it("loads actual debt once and leaves no recurring owner work", async () => {
  const service = { load: vi.fn(async () => []), settle: vi.fn(async () => true) };
  await registerRoutineExecutionStatusWork(coordinator, service, () => canRun).ready;
  expect(service.load).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(service.load).toHaveBeenCalledOnce(); expect(service.settle).not.toHaveBeenCalled(); expect(errors).toEqual([]);
});

it("reconstructs only an invalidated issue and coalesces duplicate requests", async () => {
  const service = { load: vi.fn(async (_issueId?: string) => [] as typeof entry[]), settle: vi.fn(async () => true) };
  const worker = registerRoutineExecutionStatusWork(coordinator, service, () => canRun); await worker.ready;
  service.load.mockResolvedValueOnce([entry]);
  worker.invalidate("issue"); worker.invalidate("issue");
  await vi.advanceTimersByTimeAsync(1000);
  expect(service.load).toHaveBeenLastCalledWith("issue"); expect(service.load).toHaveBeenCalledTimes(2);
  expect(service.settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(entry));
  expect(coordinator.nextWakeAt()).toBeNull(); expect(errors).toEqual([]);
});

it("retries only the failed owner at backoff and disarms after success", async () => {
  const service = { load: vi.fn(async () => [entry]), settle: vi.fn(async () => true).mockRejectedValueOnce(new Error("locked")) };
  await registerRoutineExecutionStatusWork(coordinator, service, () => canRun).ready;
  expect(errors).toHaveLength(1);
  const retryAt = coordinator.nextWakeAt(); expect(retryAt).toBe(Date.now() + 30_000);
  await vi.advanceTimersByTimeAsync(29_999); expect(service.settle).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(service.settle).toHaveBeenCalledTimes(2);
  expect(service.load).toHaveBeenCalledOnce(); expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(20 * 60_000); expect(service.settle).toHaveBeenCalledTimes(2);
});

it("retains startup and first work during drain without passive owner calls", async () => {
  canRun = false;
  const service = { load: vi.fn(async () => [entry]), settle: vi.fn(async () => true) };
  const worker = registerRoutineExecutionStatusWork(coordinator, service, () => canRun); await worker.ready;
  worker.invalidate("issue");
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(service.load).not.toHaveBeenCalled(); expect(service.settle).not.toHaveBeenCalled();
  canRun = true; await vi.advanceTimersByTimeAsync(30_000);
  expect(service.settle).toHaveBeenCalledOnce(); expect(coordinator.nextWakeAt()).toBeNull(); expect(errors).toEqual([]);
});

it("keeps a failed owner across drain and retries after resume", async () => {
  const service = { load: vi.fn(async () => [entry]), settle: vi.fn(async () => true).mockRejectedValueOnce(new Error("write failed")) };
  await registerRoutineExecutionStatusWork(coordinator, service, () => canRun).ready;
  canRun = false; await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(service.settle).toHaveBeenCalledOnce(); expect(service.load).toHaveBeenCalledOnce();
  canRun = true; await vi.advanceTimersByTimeAsync(30_000);
  expect(service.settle).toHaveBeenCalledTimes(2); expect(coordinator.nextWakeAt()).toBeNull();
});

it("retains a notification that arrives while the startup reconstruction is in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = { load: vi.fn(async (_issueId?: string) => [] as typeof entry[]), settle: vi.fn(async () => true) };
  service.load.mockImplementationOnce(async () => { await gate; return []; });
  const worker = registerRoutineExecutionStatusWork(coordinator, service, () => canRun);
  await vi.waitFor(() => expect(service.load).toHaveBeenCalledOnce());
  worker.invalidate("issue"); service.load.mockResolvedValueOnce([entry]); release(); await worker.ready;
  await vi.advanceTimersByTimeAsync(1000);
  expect(service.settle).toHaveBeenCalledOnce(); expect(coordinator.nextWakeAt()).toBeNull(); expect(errors).toEqual([]);
});

it("cancels retries and subscriptions at shutdown", async () => {
  const service = { load: vi.fn(async () => [entry]), settle: vi.fn(async () => true).mockRejectedValue(new Error("offline")) };
  const worker = registerRoutineExecutionStatusWork(coordinator, service, () => canRun); await worker.ready;
  await worker.stop(); worker.invalidate("issue"); await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(service.settle).toHaveBeenCalledOnce(); expect(coordinator.nextWakeAt()).toBeNull();
});
