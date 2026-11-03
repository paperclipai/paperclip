type SessionStreamResult<T> =
  | { kind: "stream"; value: T }
  | { kind: "exit"; exitCode: number };

export function observeSessionStreamExit<T>(
  stream: Promise<T>,
  readExit: () => Promise<number | null>,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releaseDelay: (() => void) | undefined;
  let rejectStopped!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const streamResult: Promise<SessionStreamResult<T>> = stream.then(value => ({ kind: "stream", value }));
  const probe = async (): Promise<SessionStreamResult<T>> => {
    try {
      for (const delayMs of [25, 50, 100, 200]) {
        if (stopped) return streamResult;
        await new Promise<void>(resolve => {
          releaseDelay = resolve;
          timer = setTimeout(resolve, delayMs);
        });
        if (stopped) return streamResult;
        const exitCode = await readExit();
        if (stopped) return streamResult;
        if (exitCode !== null) return { kind: "exit", exitCode };
      }
    } catch {}
    return streamResult;
  };
  const clearDelay = () => {
    clearTimeout(timer);
    releaseDelay?.();
  };
  const result = Promise.race([streamResult, probe(), cancelled]).finally(() => {
    stopped = true;
    clearDelay();
  });
  return {
    result,
    stop() {
      if (stopped) return;
      stopped = true;
      clearDelay();
      rejectStopped(new Error("Session stream exit observation stopped"));
    },
  };
}
