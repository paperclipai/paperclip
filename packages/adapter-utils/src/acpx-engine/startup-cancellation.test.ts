import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";
import type { CommandManagedDuplexChannel, CommandManagedRuntimeRunner } from "../command-managed-runtime.js";
import { cancellableSandboxStartup } from "./startup-cancellation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const result = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
function fixture(stop = vi.fn(async () => {}), extra: Partial<CommandManagedRuntimeRunner> = {}) {
  const controller = new AbortController();
  const execute = vi.fn(async () => result);
  const ctx = {
    signal: controller.signal, stopRemoteStartup: stop,
    executionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", runner: { execute, ...extra } },
  } as unknown as AdapterExecutionContext;
  const startup = cancellableSandboxStartup(ctx);
  const runner = (startup.context.executionTarget as { runner: CommandManagedRuntimeRunner }).runner;
  return { controller, execute, stop, startup, runner };
}

describe("sandbox startup cancellation boundary", () => {
  it("keeps ownership until termination is confirmed, including an early command error", async () => {
    const receipt = deferred<void>();
    const command = deferred<typeof result>();
    const f = fixture(vi.fn(() => receipt.promise));
    f.execute.mockReturnValue(command.promise);
    let settled = false;
    const outcome = f.runner.execute({ command: "setup" }).catch(error => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.controller.abort(new Error("Stopped"));
    command.reject(new Error("socket closed"));
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    receipt.resolve();
    expect(await outcome).toEqual(new Error("Stopped"));
    await expect(f.startup.finish()).rejects.toThrow("Stopped");
    await expect(f.runner.execute({ command: "late setup" })).rejects.toThrow("Stopped");
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("does not abandon a hung command when the provider cannot confirm stop", async () => {
    const command = deferred<typeof result>();
    const f = fixture(vi.fn(async () => { throw new Error("stop unverified"); }));
    f.execute.mockReturnValue(command.promise);
    let settled = false;
    const outcome = f.runner.execute({ command: "setup" }).catch(error => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.controller.abort();
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    command.resolve(result);
    expect(await outcome).toEqual(new Error("stop unverified"));
    await expect(f.startup.finish()).rejects.toThrow("stop unverified");
  });

  it("waits for all parallel setup requests after an unverified stop", async () => {
    const first = deferred<typeof result>();
    const second = deferred<typeof result>();
    const f = fixture(vi.fn(async () => { throw new Error("stop unverified"); }));
    f.execute.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let settled = false;
    const a = f.runner.execute({ command: "first" }).catch(error => error).finally(() => { settled = true; });
    const b = f.runner.execute({ command: "second" }).catch(error => error);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
    f.controller.abort();
    first.reject(new Error("first failed"));
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    second.resolve(result);
    expect(await a).toEqual(new Error("stop unverified"));
    expect(await b).toEqual(new Error("stop unverified"));
    await expect(f.startup.finish()).rejects.toThrow("stop unverified");
  });

  it("disarms after successful startup and leaves ordinary turn cancellation alone", async () => {
    const f = fixture();
    await f.runner.execute({ command: "setup" });
    await f.startup.finish();
    f.controller.abort();
    await expect(f.runner.execute({ command: "normal turn cleanup" })).resolves.toEqual(result);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("never starts a command when cancellation arrives before setup", async () => {
    const f = fixture();
    f.controller.abort(new Error("Stopped"));
    await expect(f.runner.execute({ command: "setup" })).rejects.toThrow("Stopped");
    await expect(f.startup.finish()).rejects.toThrow("Stopped");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("closes a duplex route returned after startup was cancelled", async () => {
    const opening = deferred<CommandManagedDuplexChannel>();
    const channel = {
      write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), stop: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const openDuplexChannel = vi.fn(() => opening.promise);
    const f = fixture(vi.fn(async () => {}), { openDuplexChannel });
    const outcome = f.runner.openDuplexChannel!({ command: ["agent"] }).catch(error => error);
    await vi.waitFor(() => expect(openDuplexChannel).toHaveBeenCalledOnce());
    f.controller.abort(new Error("Stopped"));
    expect(await outcome).toEqual(new Error("Stopped"));
    opening.resolve(channel);
    await vi.waitFor(() => expect(channel.close).toHaveBeenCalledOnce());
    await expect(f.startup.finish()).rejects.toThrow("Stopped");
  });

  it("does not stop another run's runner", async () => {
    const a = fixture();
    const b = fixture();
    a.controller.abort(new Error("Stopped"));
    await expect(a.startup.finish()).rejects.toThrow("Stopped");
    await expect(b.runner.execute({ command: "setup" })).resolves.toEqual(result);
    await b.startup.finish();
    expect(b.stop).not.toHaveBeenCalled();
  });
});
