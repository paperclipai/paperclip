import { randomUUID } from "node:crypto";

export type SingleFlightTaskStart<T> =
  | {
      started: true;
      invocationId: string;
      promise: Promise<T>;
    }
  | {
      started: false;
      activeInvocationId: string;
      activeDurationMs: number;
    };

export function createSchedulerSingleFlight<T>(task: (context: { invocationId: string }) => Promise<T>) {
  let active: {
    invocationId: string;
    startedAtMs: number;
    promise: Promise<T>;
  } | null = null;

  return {
    start(): SingleFlightTaskStart<T> {
      if (active) {
        return {
          started: false,
          activeInvocationId: active.invocationId,
          activeDurationMs: Math.max(0, Date.now() - active.startedAtMs),
        };
      }

      const invocationId = randomUUID();
      const startedAtMs = Date.now();
      let promise: Promise<T>;
      promise = Promise.resolve()
        .then(() => task({ invocationId }))
        .finally(() => {
          if (active?.promise === promise) active = null;
        });
      active = { invocationId, startedAtMs, promise };

      return { started: true, invocationId, promise };
    },
  };
}
