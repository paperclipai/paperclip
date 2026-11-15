const CANCELLED = "Telegram login cancelled.";
const TIMED_OUT = "Cloud password timed out.";
const DEFAULT_WAIT_MS = 3 * 60 * 1000;

type Waiter = {
  promise: Promise<string>;
  resolve: (password: string) => void;
  reject: (error: Error) => void;
};

export function createLoginPasswordGate(options?: { waitMs?: number }) {
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  let cancelled = false;
  let stop: string | null = null;
  let attemptMessage: string | null = null;
  let pending: Waiter | null = null;

  function rejectPending(error: Error) {
    const current = pending;
    pending = null;
    current?.reject(error);
  }

  return {
    wasCancelled: () => cancelled,
    stopMessage: () => stop,
    noteFailure(message: string) {
      attemptMessage = message;
    },
    noteStop(message: string) {
      cancelled = true;
      stop = message;
      rejectPending(new Error(message));
    },
    cancel() {
      cancelled = true;
      stop = CANCELLED;
      rejectPending(new Error(CANCELLED));
    },
    async ask(onAsk: (message: string | null) => void): Promise<string> {
      if (cancelled) throw new Error(stop ?? CANCELLED);
      const message = attemptMessage;
      attemptMessage = null;
      let resolve!: (password: string) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const wait: Waiter = { promise, resolve, reject };
      pending = wait;
      onAsk(message);
      const timer = setTimeout(() => {
        if (pending !== wait) return;
        cancelled = true;
        stop = TIMED_OUT;
        rejectPending(new Error(TIMED_OUT));
      }, waitMs);
      try {
        return await promise;
      } finally {
        clearTimeout(timer);
        if (pending === wait) pending = null;
      }
    },
    submit(password: string) {
      const current = pending;
      if (!current) throw new Error("No Telegram login is waiting for a password.");
      pending = null;
      current.resolve(password);
    },
  };
}
