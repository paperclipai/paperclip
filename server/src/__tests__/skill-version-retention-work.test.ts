import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { noteSkillVersionCacheChange } from "../services/skill-version-retention-notifications.js";
import { registerSkillVersionRetentionWork } from "../services/skill-version-retention-work.js";
import type { skillVersionRetentionService } from "../services/skill-version-retention.js";

let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
let worker: ReturnType<typeof registerSkillVersionRetentionWork> | undefined;
let home: string | undefined;
afterEach(async () => {
  worker?.unsubscribe();
  await coordinator?.stop();
  await worker?.dispose();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
});

it("keeps an expired cache change eligible when its own paged scan finishes", async () => {
  home = mkdtempSync(path.join(tmpdir(), "sleep64-retention-work-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "sleep64-retention-work");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  const companyId = randomUUID();
  let page = 0;
  const prune = vi.fn(async (_companyId: string, _options: { cursor: unknown }) => {
    const truncated = ++page < 4;
    return { checked: truncated ? 50 : 0, removed: 0, failed: 0, skipped: {},
      truncated, interrupted: false, nextRunAt: null, cursor: truncated ? { page } : null };
  });
  const service = { graceMs: 2_500, dryRun: false, listCompanies: async () => [{ id: companyId }],
    pruneCompany: prune, dispose: async () => {} } as unknown as ReturnType<typeof skillVersionRetentionService>;
  const onError = vi.fn();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  worker = registerSkillVersionRetentionWork(coordinator, service, () => true);
  await worker.ready;
  expect(prune).toHaveBeenCalledOnce();
  noteSkillVersionCacheChange(path.join(resolvePaperclipInstanceRoot(), "skills", companyId,
    "__versions__", randomUUID(), randomUUID()), { source: "access" });
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(prune).toHaveBeenCalledTimes(5);
  expect(prune.mock.calls[4]).toEqual([companyId, expect.objectContaining({ cursor: null })]);
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(prune).toHaveBeenCalledTimes(5);
  expect(onError).not.toHaveBeenCalled();
});

it("continues a successful page when another company's grace deadline expires during it", async () => {
  home = mkdtempSync(path.join(tmpdir(), "retention-page-deadline-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "retention-page-deadline");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
  const startedAt = Date.now();
  const dueCompany = randomUUID(), pagedCompany = randomUUID();
  const began = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let pages = 0, dueScans = 0;
  const prune = vi.fn(async (id: string) => {
    const due = id === dueCompany;
    if (due) dueScans++;
    else if (++pages === 2) { began.resolve(); await release.promise; }
    const truncated = !due && pages < 3;
    return { checked: due ? 2 : pages === 1 ? 48 : 50, removed: 0, failed: 0, skipped: {},
      truncated, interrupted: false, nextRunAt: due && dueScans === 1 ? startedAt + 5_000 : null,
      cursor: truncated ? { skillId: "page", name: String(pages) } : null };
  });
  const service = { graceMs: 5_000, dryRun: false,
    listCompanies: async () => [{ id: dueCompany }, { id: pagedCompany }],
    pruneCompany: prune, dispose: async () => {} } as unknown as ReturnType<typeof skillVersionRetentionService>;
  const onError = vi.fn();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  worker = registerSkillVersionRetentionWork(coordinator, service, () => true);
  await worker.ready;
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    await began.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const next = coordinator.nextWakeAt();
    expect(next === null ? 0 : next - Date.now()).toBeLessThanOrEqual(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pages).toBe(3);
    expect(dueScans).toBe(2);
    expect(coordinator.nextWakeAt()).toBeNull();
    const calls = prune.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prune).toHaveBeenCalledTimes(calls);
    expect(onError).not.toHaveBeenCalled();
  } finally { release.resolve(); }
});
