import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

let capture: { command: string[]; stdout: PassThrough; stdin: PassThrough; tty: boolean; callback: (status: { status: string; details?: { causes?: { reason: string; message: string }[] } }) => void; socket: EventEmitter & { close: ReturnType<typeof vi.fn>; bufferedAmount: number } } | undefined;
vi.mock("@kubernetes/client-node", () => ({
  Exec: class {
    async exec(_ns: string, _pod: string, _container: string, command: string[], stdout: PassThrough, _stderr: PassThrough, stdin: PassThrough, tty: boolean, callback: typeof capture.callback) {
      const socket = Object.assign(new EventEmitter(), { close: vi.fn(), bufferedAmount: 0 });
      // SDK immediately forwards data to socket.send; stdin.writableLength drains.
      stdin.on("data", (chunk: Buffer) => { socket.bufferedAmount += chunk.length + 1; });
      capture = { command, stdout, stdin, tty, callback, socket };
      return socket;
    }
  },
}));
const { connectKubernetesLoginPty } = await import("../../src/login-pty-exec.js");
const scope = { companyId: "co", environmentId: "env", leaseId: "lease", namespace: "ns", podName: "pod", config: { inCluster: true } };
// BUGFIX (see login-pty-exec.ts): the runner now ALWAYS waits for the Sandbox
// CR to reach Ready via `resolvePod`, even when `scope.podName` was already
// known — a cached podName does not mean the pod is Ready yet. Every test
// therefore supplies a `resolvePod` stub standing in for that readiness wait.
const resolveReady = vi.fn(async () => "pod");

describe("Kubernetes Exec PTY transport", () => {
  it("uses tty=true and leaves stdin open for delayed secret input", async () => {
    const output = vi.fn(); const exit = vi.fn();
    const connection = await connectKubernetesLoginPty(scope, ["claude"], { tty: true, output, exit }, {} as never, resolveReady);
    expect(capture?.tty).toBe(true);
    expect(capture?.command).toEqual(["claude"]);
    const chunks: Buffer[] = [];
    capture!.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    connection.write("secret\r");
    expect(Buffer.concat(chunks).toString()).toBe("secret\r");
    capture!.stdout.write(Buffer.from("prompt"));
    expect(output).toHaveBeenCalledWith(Buffer.from("prompt"));
    capture!.callback({ status: "Failure", details: { causes: [{ reason: "ExitCode", message: "7" }] } });
    expect(exit).toHaveBeenCalledWith(7);
    connection.close();
    expect(capture!.socket.close).toHaveBeenCalledOnce();
  });

  it("always resolves/waits for the pod before opening Exec, even with a cached podName", async () => {
    const resolve = vi.fn(async () => "new-pod");
    await connectKubernetesLoginPty({ ...scope, podName: null }, ["claude"], { tty: true, output: vi.fn(), exit: vi.fn() }, {} as never, resolve);
    expect(resolve).toHaveBeenCalledWith("ns", "lease");
    expect(capture?.command).toEqual(["claude"]);
  });

  it("still waits for readiness when scope.podName is already set (regression: stale pod names must not skip the wait)", async () => {
    const resolve = vi.fn(async () => "pod");
    await connectKubernetesLoginPty(scope, ["claude"], { tty: true, output: vi.fn(), exit: vi.fn() }, {} as never, resolve);
    expect(resolve).toHaveBeenCalledWith("ns", "lease");
  });

  it("closes the socket when buffered stdin exceeds the host-side cap", async () => {
    const exit = vi.fn();
    const connection = await connectKubernetesLoginPty(scope, ["claude"], { tty: true, output: vi.fn(), exit }, {} as never, resolveReady);
    for (let i = 0; i < 8; i++) connection.write("x".repeat(65536));
    expect(capture!.socket.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(null);
  });

  it("accepts later input when the WebSocket has drained", async () => {
    const exit = vi.fn();
    const connection = await connectKubernetesLoginPty(scope, ["claude"], { tty: true, output: vi.fn(), exit }, {} as never, resolveReady);
    for (let i = 0; i < 8; i++) {
      connection.write("x".repeat(65536));
      capture!.socket.bufferedAmount = 0;
    }
    expect(capture!.socket.close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    connection.close();
  });

  it("reports abnormal socket close as null exit", async () => {
    const exit = vi.fn();
    await connectKubernetesLoginPty(scope, ["claude"], { tty: true, output: vi.fn(), exit }, {} as never, resolveReady);
    capture!.socket.emit("close");
    expect(exit).toHaveBeenCalledWith(null);
  });
});
