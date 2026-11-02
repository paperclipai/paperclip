import type { Db } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerRunEvidenceMigrationWork } from "../services/run-evidence-migration-work.js";

const state = vi.hoisted(() => ({
  provider: "s3",
  migrate: vi.fn(),
  probe: undefined as undefined | (() => string),
  unregister: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../storage/config.js", () => ({
  loadStorageConfig: () => ({ storageProvider: state.provider }),
}));
vi.mock("../services/run-evidence-migration.js", () => ({ migrateRunEvidence: state.migrate }));
vi.mock("../middleware/logger.js", () => ({ logger: { info: state.info, warn: state.warn } }));
vi.mock("../services/idle-local-work.js", () => ({
  registerIdleLocalWorkProbe: (probe: () => string) => {
    state.probe = probe;
    return state.unregister;
  },
}));
let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
afterEach(async () => {
  await coordinator?.stop();
  coordinator = undefined;
  state.provider = "s3";
  state.probe = undefined;
  vi.resetAllMocks();
  vi.useRealTimers();
});
function setup(canRun = () => true) {
  vi.useFakeTimers();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  const onError = vi.fn();
  coordinator = createDeliveryWorkCoordinator({ owner, canRun, canReconcile: () => true, onError });
  const worker = registerRunEvidenceMigrationWork(owner as unknown as Db, coordinator, canRun);
  return { worker, onError };
}
it("does no migration work for local storage", async () => {
  state.provider = "local_disk";
  const { worker } = setup();
  expect(worker).toBeNull();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(state.migrate).not.toHaveBeenCalled();
  expect(state.probe).toBeUndefined();
  expect(coordinator!.nextWakeAt()).toBeNull();
});
it("automatically pages both resources, then leaves completed history quiet", async () => {
  state.migrate
    .mockResolvedValueOnce({
      items: [{ kind: "log", id: "one", state: "migrated" }],
      nextRunId: "one",
    })
    .mockResolvedValueOnce({
      items: [{ kind: "log", id: "two", state: "migrated" }],
      nextRunId: "two",
    })
    .mockResolvedValue({ items: [] });
  const { worker, onError } = setup();
  expect(state.probe!()).toBe("unknown");
  await worker!.ready;
  expect(state.migrate).toHaveBeenNthCalledWith(
    1,
    expect.anything(),
    expect.objectContaining({
      apply: true,
      limit: 1,
      kinds: ["log", "trace"],
    }),
  );
  expect(state.probe!()).toBe("present");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(state.migrate).toHaveBeenNthCalledWith(
    2,
    expect.anything(),
    expect.objectContaining({
      afterRunId: "one",
      kinds: ["log"],
    }),
  );
  expect(state.migrate).toHaveBeenNthCalledWith(
    3,
    expect.anything(),
    expect.objectContaining({
      afterRunId: "two",
      kinds: ["log"],
    }),
  );
  expect(state.probe!()).toBe("none");
  expect(coordinator!.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(state.migrate).toHaveBeenCalledTimes(3);
  expect(onError).not.toHaveBeenCalled();
  await worker!.stop();
  expect(state.unregister).toHaveBeenCalledOnce();
});
it("keeps blocked history visible and retries it without stranding later pages", async () => {
  state.migrate
    .mockResolvedValueOnce({
      items: [{ kind: "log", id: "active", state: "blocked", reason: "legacy_writer_not_settled" }],
      nextRunId: "active",
    })
    .mockResolvedValueOnce({ items: [{ kind: "log", id: "later", state: "migrated" }] })
    .mockResolvedValue({ items: [{ kind: "log", id: "active", state: "migrated" }] });
  const { worker } = setup();
  await worker!.ready;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(state.warn).toHaveBeenCalledWith(
    expect.objectContaining({ id: "active", reason: "legacy_writer_not_settled" }),
    expect.any(String),
  );
  expect(state.probe!()).toBe("present");
  await vi.advanceTimersByTimeAsync(299_999);
  expect(state.migrate).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.migrate).toHaveBeenNthCalledWith(
    3,
    expect.anything(),
    expect.objectContaining({ afterRunId: undefined, kinds: ["log", "trace"] }),
  );
  expect(state.probe!()).toBe("none");
  expect(coordinator!.nextWakeAt()).toBeNull();
});
it("retains startup work during drain and retries a failed sweep before becoming quiet", async () => {
  let admitted = false;
  state.migrate
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockResolvedValue({ items: [] });
  const { worker, onError } = setup(() => admitted);
  await worker!.ready;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.migrate).not.toHaveBeenCalled();
  expect(state.probe!()).toBe("unknown");
  admitted = true;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(onError).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(state.migrate).toHaveBeenCalledTimes(2);
  expect(state.probe!()).toBe("none");
  expect(coordinator!.nextWakeAt()).toBeNull();
});
it("aborts owned work on shutdown and reconstructs outstanding history on restart", async () => {
  let started: AbortSignal | undefined;
  state.migrate.mockImplementationOnce(
    (_db, options) =>
      new Promise((_resolve, reject) => {
        started = options.signal;
        started!.addEventListener("abort", () => reject(started!.reason), { once: true });
      }),
  );
  const { worker } = setup();
  await vi.advanceTimersByTimeAsync(0);
  expect(started?.aborted).toBe(false);
  await worker!.stop();
  await worker!.ready;
  expect(started?.aborted).toBe(true);
  expect(coordinator!.nextWakeAt()).toBeNull();
  await coordinator!.stop();
  state.migrate.mockResolvedValue({ items: [] });
  const restarted = setup();
  await restarted.worker!.ready;
  expect(state.migrate).toHaveBeenCalledTimes(2);
  expect(state.probe!()).toBe("none");
});
