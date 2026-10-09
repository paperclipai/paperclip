import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";

// Node publishes the real ChildProcess before its spawn event. ACP's spawn
// callback only exposes a PID, so correlate it here while retaining the handle
// for all later control. Never resolve a numeric PID again when stopping it.
// https://nodejs.org/api/diagnostics_channel.html#event-child_process
const children = new Map<number, ChildProcess>();
channel("child_process").subscribe((message) => {
  const child = (message as { process?: unknown }).process;
  if (!(child instanceof ChildProcess)) return;
  child.once("spawn", () => {
    if (child.pid) children.set(child.pid, child);
  });
  const remove = () => {
    if (child.pid && children.get(child.pid) === child) children.delete(child.pid);
  };
  child.once("exit", remove);
  child.once("close", remove);
});

export function captureLocalProcess(pid: number): ChildProcess | undefined {
  return children.get(pid);
}

export function capturedProcessExited(child: Pick<ChildProcess, "exitCode" | "signalCode"> | undefined): boolean {
  return Boolean(child && (child.exitCode !== null || child.signalCode !== null));
}

export function killCapturedLocalProcess(child: Pick<ChildProcess, "exitCode" | "signalCode" | "kill"> | undefined): boolean {
  if (!child || capturedProcessExited(child)) return false;
  try { return child.kill("SIGKILL"); } catch { return false; }
}
