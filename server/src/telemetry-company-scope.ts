import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

export function withTelemetryCompany<T>(companyId: string | null | undefined, fn: () => T): T {
  return companyId ? storage.run(companyId, fn) : fn();
}

export function scopedTelemetryCompanyId(): string | undefined {
  return storage.getStore();
}
