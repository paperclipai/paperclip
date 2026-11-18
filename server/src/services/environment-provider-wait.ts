export const ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON = "environment_provider_wait";

export const ENVIRONMENT_PROVIDER_WAIT = {
  delaysMs: [60_000, 2 * 60_000, 5 * 60_000],
  ceilingMs: 30 * 60_000,
  maxAttempts: 12,
  parkedRecheckMs: 30_000,
  probeStartGraceMs: 60_000,
  probeRunningBoundMs: 10 * 60_000,
  wakeReason: "transient_failure_retry",
} as const;

export const ENVIRONMENT_PROVIDER_WAIT_KEY = "environmentProviderWait";

export type EnvironmentProviderWait = { environmentId: string; environmentName: string | null; waitingSince: string };

type WaitRun = {
  errorCode?: string | null;
  scheduledRetryReason?: string | null;
  scheduledRetryAttempt?: number | null;
  contextSnapshot?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readEnvironmentProviderWait(contextSnapshot: unknown): EnvironmentProviderWait | null {
  const wait = record(record(contextSnapshot)[ENVIRONMENT_PROVIDER_WAIT_KEY]);
  const { environmentId, environmentName, waitingSince } = wait;
  if (typeof environmentId !== "string" || !UUID.test(environmentId)) return null;
  if (typeof waitingSince !== "string" || !Number.isFinite(Date.parse(waitingSince))) return null;
  return { environmentId, environmentName: typeof environmentName === "string" && environmentName.trim() ? environmentName : null,
    waitingSince };
}

function failedEnvironment(run: WaitRun): { environmentId: string; environmentName: string | null } | null {
  const provider = record(record(run.resultJson).environmentProvider);
  if (typeof provider.environmentId !== "string" || !UUID.test(provider.environmentId)) return null;
  return { environmentId: provider.environmentId,
    environmentName: typeof provider.environmentName === "string" && provider.environmentName.trim() ? provider.environmentName : null };
}

export function environmentProviderWaitFor(run: WaitRun, now: Date): EnvironmentProviderWait | null {
  const environment = failedEnvironment(run);
  if (!environment) return null;
  const saved = run.scheduledRetryReason === ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON
    ? readEnvironmentProviderWait(run.contextSnapshot) : null;
  const waitingSince = saved && saved.environmentId === environment.environmentId ? saved.waitingSince : now.toISOString();
  return { ...environment, waitingSince };
}

export function environmentProviderWaitRetry(run: WaitRun, now: Date) {
  const wait = environmentProviderWaitFor(run, now);
  if (!wait) return null;
  const consumed = run.scheduledRetryReason === ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON ? run.scheduledRetryAttempt ?? 0 : 0;
  const remainingMs = Date.parse(wait.waitingSince) + ENVIRONMENT_PROVIDER_WAIT.ceilingMs - now.getTime();
  const delays = ENVIRONMENT_PROVIDER_WAIT.delaysMs;
  const delayMs = Math.min(delays[Math.min(consumed, delays.length - 1)]!, Math.max(0, remainingMs));
  return {
    retryReason: ENVIRONMENT_PROVIDER_WAIT_RETRY_REASON,
    wakeReason: ENVIRONMENT_PROVIDER_WAIT.wakeReason,
    maxAttempts: remainingMs > 0 ? ENVIRONMENT_PROVIDER_WAIT.maxAttempts : consumed,
    delayMs,
  };
}

export function environmentProviderWaitMessage(environmentName: string | null): string {
  const name = environmentName?.trim() ? `"${environmentName.trim()}"` : "the sandbox provider";
  return `Waiting for ${name} to come back. Paperclip continues this task automatically when it does.`;
}
