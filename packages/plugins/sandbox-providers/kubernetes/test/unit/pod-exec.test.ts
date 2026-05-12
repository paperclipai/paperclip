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
      statusCallback({ status: "Success" });
      return Promise.resolve(new EventEmitter());
    });

    const result = await execInPod({} as never, "ns", "pod-1", "agent", ["echo", "ok"]);
    expect(result).toEqual({ exitCode: 0, timedOut: false, stdout: "ok\n", stderr: "" });
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
});
