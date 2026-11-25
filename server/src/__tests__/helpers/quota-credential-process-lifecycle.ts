import type { ChildProcess } from "node:child_process";

/** Observe the receiver from spawn onward without logging credentials or errors. */
export function monitorQuotaCredentialProcess(child: ChildProcess) {
  let stage = "startup", ready = false, ended = false;
  let failure: Error | undefined, stopping: Promise<void> | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void, resolveEnded!: () => void;
  const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // An error can arrive before the startup hook begins awaiting readiness.
  void readiness.catch(() => {});
  const termination = new Promise<void>(resolve => { resolveEnded = resolve; });
  const diagnostic = (at = stage, code = child.exitCode, signal = child.signalCode) =>
    new Error(`Quota credential receiver stopped: stage=${at}, exitCode=${code}, signal=${signal}`);
  const fail = (error: Error) => { failure ??= error; rejectReady(failure); };
  const cleanup = () => {
    child.off("message", onMessage);
    child.off("error", onError);
    child.off("exit", onExit);
    child.off("close", onExit);
  };
  const onMessage = (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "ready") {
      ready = true;
      stage = "ready";
      resolveReady();
    }
  };
  const onError = () => { fail(diagnostic("spawn-error")); };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    ended = true;
    fail(diagnostic(stage, code, signal));
    cleanup();
    resolveEnded();
  };
  child.on("message", onMessage);
  child.on("error", onError);
  child.on("exit", onExit);
  child.on("close", onExit);

  function assertRunning() {
    if (failure) throw failure;
    if (ended || child.exitCode !== null || child.signalCode !== null || stopping) throw diagnostic();
  }

  return {
    assertRunning,
    async waitForReady(timeoutMs: number) {
      assertRunning();
      if (ready) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          readiness,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(diagnostic("startup-timeout")), timeoutMs);
          }),
        ]);
        assertRunning();
      } finally { clearTimeout(timer); }
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = termination;
      if (!ended && (child.exitCode !== null || child.signalCode !== null)) onExit(child.exitCode, child.signalCode);
      if (!ended && child.pid !== undefined) child.kill("SIGKILL");
      return stopping;
    },
  };
}
