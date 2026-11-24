import os from "node:os";

function parsePositiveIntegerEnv(raw, name) {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer. Received "${raw}".`);
  }
  return parsed;
}

export function resolveAvailableCpuCount(env = process.env) {
  const override = env.PAPERCLIP_VITEST_CPU_COUNT?.trim();
  if (override) {
    return parsePositiveIntegerEnv(override, "PAPERCLIP_VITEST_CPU_COUNT");
  }
  return Math.max(1, os.availableParallelism());
}

export function defaultServerParallelWorkers(lane, cpuCount = resolveAvailableCpuCount()) {
  if (!Number.isInteger(cpuCount) || cpuCount < 1) {
    throw new Error(`CPU count must be a positive integer. Received "${cpuCount}".`);
  }
  if (lane === "general") {
    // 4-core runners keep 4 workers; 8-core runners scale to 7 (leaving 1 core
    // for shared PostgreSQL + Vitest coordinator) and cap at 8 on large hosts.
    if (cpuCount <= 4) {
      return cpuCount;
    }
    return Math.min(8, cpuCount - 1);
  }
  if (lane === "serialized") {
    // Route/authz suites are heavier per fork; keep 3 workers on 4-core runners
    // and scale smoothly to 5 workers on 8-core runners (capped at 6).
    if (cpuCount <= 2) return 1;
    if (cpuCount === 3) return 2;
    if (cpuCount === 4) return 3;
    return Math.min(6, Math.max(3, Math.round((cpuCount * 5) / 8)));
  }
  throw new Error(`Unknown server worker lane "${lane}". Expected "general" or "serialized".`);
}

export function resolveServerParallelWorkers(lane, env = process.env) {
  const raw = env.PAPERCLIP_VITEST_MAX_WORKERS?.trim();
  if (raw) {
    return parsePositiveIntegerEnv(raw, "PAPERCLIP_VITEST_MAX_WORKERS");
  }
  return defaultServerParallelWorkers(lane, resolveAvailableCpuCount(env));
}

export function resolveWorkspaceParallelWorkers(env = process.env) {
  const raw = env.PAPERCLIP_VITEST_MAX_WORKERS?.trim();
  if (raw) {
    return parsePositiveIntegerEnv(raw, "PAPERCLIP_VITEST_MAX_WORKERS");
  }
  // Vitest defaults to cpus - 1 for forks (3 workers on 4-core CI, leaving a core idle).
  // Use 4 workers on 4-core runners and cap at 7 on 8+-core runners so 1 core stays
  // free for the Vite transform server.
  return Math.min(7, resolveAvailableCpuCount(env));
}
