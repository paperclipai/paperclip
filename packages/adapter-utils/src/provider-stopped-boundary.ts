/** Per-adapter invocation fence. A failed later attempt invalidates an earlier
 * stop receipt; a late callback from that earlier attempt cannot restore it. */
export function createProviderStoppedBoundary(onProviderStopped?: () => Promise<void>) {
  let invocation = 0;
  let stopped = false;
  let collected = false;
  return {
    beginInvocation(): () => void {
      const current = ++invocation;
      stopped = false;
      return () => { if (invocation === current) stopped = true; };
    },
    async collectBeforeRestore() {
      if (!stopped || collected || !onProviderStopped) return;
      collected = true;
      await onProviderStopped();
    },
  };
}
