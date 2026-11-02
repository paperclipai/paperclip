import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { captureLocalProcess, capturedProcessExited, killCapturedLocalProcess } from "./local-process-control.js";

it("captures and terminates the actual spawned child on the current platform", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(child, "spawn");
    const captured = captureLocalProcess(child.pid!);
    expect(captured).toBe(child);
    expect(capturedProcessExited(captured)).toBe(false);
    const exited = once(child, "exit");
    expect(killCapturedLocalProcess(captured)).toBe(true);
    await exited;
    expect(capturedProcessExited(captured)).toBe(true);
    expect(captureLocalProcess(child.pid!)).toBeUndefined();
  } finally {
    if (!capturedProcessExited(child)) child.kill("SIGKILL");
  }
});

it("never signals an exited child even if another process has reused its PID", () => {
  const original = { pid: 123, exitCode: 0, signalCode: null, kill: vi.fn(() => true) };
  const replacement = { pid: 123, exitCode: null, signalCode: null, kill: vi.fn(() => true) };
  expect(killCapturedLocalProcess(original)).toBe(false);
  expect(original.kill).not.toHaveBeenCalled();
  expect(replacement.kill).not.toHaveBeenCalled();
});

it("fails closed when the spawned handle was not captured", () => {
  expect(killCapturedLocalProcess(undefined)).toBe(false);
  expect(capturedProcessExited(undefined)).toBe(false);
});

it("reports an unsuccessful signal without throwing", () => {
  expect(killCapturedLocalProcess({ exitCode: null, signalCode: null, kill: () => false })).toBe(false);
  expect(killCapturedLocalProcess({ exitCode: null, signalCode: null, kill: () => { throw new Error("gone"); } })).toBe(false);
});
