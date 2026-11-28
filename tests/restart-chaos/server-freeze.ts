import { setTimeout as delay } from "node:timers/promises";

export type SendSignal = (pid: number, signal: NodeJS.Signals) => void;

const sendSignal: SendSignal = (pid, signal) => { process.kill(pid, signal); };

function alive(pid: number, send: SendSignal): boolean {
  try { send(pid, 0 as unknown as NodeJS.Signals); return true; } catch { return false; }
}

export async function whileFrozen<T>(input: { pid: number | null | undefined; freezeMs: number | null; send?: SendSignal; wait?: (ms: number) => Promise<unknown> },
  body: () => Promise<T>): Promise<{ result: T; frozenAt: number | null; thawedAt: number | null }> {
  const send = input.send ?? sendSignal;
  const wait = input.wait ?? (ms => delay(ms));
  const frozenAt = input.freezeMs !== null && input.pid ? Date.now() : null;
  if (frozenAt !== null) send(input.pid!, "SIGSTOP");
  let thawedAt: number | null = null;
  const thaw = () => {
    if (frozenAt === null || thawedAt !== null) return;
    thawedAt = Date.now();
    if (alive(input.pid!, send)) send(input.pid!, "SIGCONT");
  };
  try {
    const result = await body();
    if (frozenAt !== null) await wait(Math.max(0, frozenAt + input.freezeMs! - Date.now()));
    thaw();
    return { result, frozenAt, thawedAt };
  } finally {
    thaw();
  }
}
