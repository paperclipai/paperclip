import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();

vi.mock("@kubernetes/client-node", () => ({
  Exec: vi.fn().mockImplementation(() => ({ exec: execMock })),
}));

const { execInPod } = await import("../../src/pod-exec.js");

describe("execInPod", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("returns success when the Kubernetes exec status callback reports success", async () => {
    execMock.mockImplementation((_namespace, _pod, _container, _command, stdout, _stderr, _stdin, _tty, statusCallback) => {
      stdout.write("ok\n");
      stdout.end();
      _stderr.end();
      statusCallback({ status: "Success" });
      return Promise.resolve(new EventEmitter());
    });

    const result = await execInPod({} as never, "ns", "pod-1", "agent", ["echo", "ok"]);
    expect(result).toEqual({ exitCode: 0, timedOut: false, stdout: "ok\n", stderr: "" });
  });

  it("finishes when Kubernetes reports status without ending output streams", async () => {
    execMock.mockImplementation((_namespace, _pod, _container, _command, stdout, _stderr, _stdin, _tty, statusCallback) => {
      stdout.write("ok\n");
      statusCallback({ status: "Success" });
      return Promise.resolve(new EventEmitter());
    });

    const result = await execInPod({} as never, "ns", "pod-1", "agent", ["echo", "ok"]);
    expect(result).toEqual({ exitCode: 0, timedOut: false, stdout: "ok\n", stderr: "" });
  });

  it("handles output stream errors after status completion", async () => {
    execMock.mockImplementation((_namespace, _pod, _container, _command, stdout, _stderr, _stdin, _tty, statusCallback) => {
      statusCallback({ status: "Success" });
      stdout.emit("error", new Error("write after end"));
      return Promise.resolve(new EventEmitter());
    });

    const result = await execInPod({} as never, "ns", "pod-1", "agent", ["echo", "ok"]);
    expect(result).toEqual({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
  });

  it("returns an execution failure if the websocket closes before a status frame", async () => {
    const ws = new EventEmitter();
    execMock.mockResolvedValue(ws);

    const resultPromise = execInPod({} as never, "ns", "pod-1", "agent", ["sleep", "1"]);
    await Promise.resolve();
    ws.emit("close", 1006, Buffer.from("connection lost"));

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 1,
      timedOut: false,
      stderr: expect.stringContaining("websocket closed before status frame"),
    });
  });

  it("returns an execution failure if the exec command exceeds its deadline", async () => {
    execMock.mockResolvedValue(new EventEmitter());

    const result = await execInPod({} as never, "ns", "pod-1", "agent", ["sleep", "60"], undefined, 5);

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("Kubernetes exec timed out after 5ms");
  });

  it("clears the timeout when websocket setup rejects", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    execMock.mockRejectedValue(new Error("network unreachable"));

    await expect(
      execInPod({} as never, "ns", "pod-1", "agent", ["echo", "ok"], undefined, 1000),
    ).rejects.toThrow("network unreachable");
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("wraps stdin commands with a byte-counted reader prefix", async () => {
    let observedCommand: string[] | undefined;
    let observedStdin = "";
    let observedStdinFinished = false;

    execMock.mockImplementation((_namespace, _pod, _container, command, stdout, stderr, stdin, _tty, statusCallback) => {
      observedCommand = command;
      stdin?.on("data", (chunk: Buffer) => {
        observedStdin += chunk.toString("utf8");
      });
      stdin?.on("finish", () => {
        observedStdinFinished = true;
      });
      stdout.end();
      stderr.end();
      statusCallback({ status: "Success" });
      return Promise.resolve(new EventEmitter());
    });

    await execInPod({} as never, "ns", "pod-1", "agent", ["base64", "-d"], "abc");
    await Promise.resolve();

    expect(observedCommand?.[0]).toBe("/bin/sh");
    expect(observedCommand?.[1]).toBe("-c");
    expect(observedCommand?.[2]).toContain("dd bs=1 count=3");
    expect(observedCommand?.[2]).toContain("head -c 3");
    expect(observedCommand?.[2]).toContain("| 'base64' '-d'");
    expect(observedStdin).toBe("abc");
    expect(observedStdinFinished).toBe(true);
  });

  it("does not send stdin if the exec timed out before websocket setup completed", async () => {
    let resolveWebsocket: ((ws: EventEmitter) => void) | undefined;
    let observedStdin = "";
    let observedStdinFinished = false;
    const ws = Object.assign(new EventEmitter(), { close: vi.fn() });

    execMock.mockImplementation((_namespace, _pod, _container, _command, _stdout, _stderr, stdin) => {
      stdin?.on("data", (chunk: Buffer) => {
        observedStdin += chunk.toString("utf8");
      });
      stdin?.on("finish", () => {
        observedStdinFinished = true;
      });
      return new Promise<EventEmitter>((resolve) => {
        resolveWebsocket = resolve;
      });
    });

    const result = await execInPod({} as never, "ns", "pod-1", "agent", ["base64", "-d"], "abc", 5);
    expect(result.timedOut).toBe(true);

    resolveWebsocket?.(ws);
    await Promise.resolve();

    expect(ws.close).toHaveBeenCalled();
    expect(observedStdin).toBe("");
    expect(observedStdinFinished).toBe(false);
  });
});
