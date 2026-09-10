/** Live adapter ownership shared by routes and scheduler service instances. */
export function createAdapterExecutionControl() {
  const controller = new AbortController();
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  return { controller, settled, finish };
}

export const adapterExecutionControls = new Map<string, ReturnType<typeof createAdapterExecutionControl>>();

export async function waitForAdapterStop(settled: Promise<void>, timeoutMs = 60_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Execution is still stopping; termination has not been verified.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
