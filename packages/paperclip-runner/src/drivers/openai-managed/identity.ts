/** The controller thread is fixed before the API can create a paid session. */
export function isOpenAiRemoteSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value) && !value.startsWith("pending_");
}

export function isOpenAiSessionCreation(driverId: string, previous: string | null, current: string | null): boolean {
  return /^pending_[a-f0-9]{64}$/.test(driverId) && previous === driverId
    && isOpenAiRemoteSessionId(current);
}
