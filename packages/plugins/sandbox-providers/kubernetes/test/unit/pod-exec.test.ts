import { describe, it, expect, vi } from "vitest";
import type { PassThrough } from "node:stream";

// Mock the k8s client so `execInPod` runs against a scripted WebSocket exec: the
// fake `Exec.exec` streams stdout chunks into the provided PassThrough and, for
// the success path, reports an exit status. This exercises the host-side stdout
// accumulation cap without a real cluster.
type StatusCb = (status: {
  status: string;
  details?: { causes?: { reason?: string; message?: string }[] };
}) => void;

let scriptedExec: (
  stdout: PassThrough,
  stderr: PassThrough,
  statusCb: StatusCb,
) => void = () => undefined;

vi.mock("@kubernetes/client-node", () => {
  class Exec {
    constructor(_kc: unknown) {}
    async exec(
      _namespace: string,
      _podName: string,
      _containerName: string,
      _command: string[],
      stdout: PassThrough,
      stderr: PassThrough,
      _stdin: PassThrough | null,
      _tty: boolean,
      statusCb: StatusCb,
    ) {
      // Defer so the caller has wired its stream listeners first.
      setImmediate(() => scriptedExec(stdout, stderr, statusCb));
      return { close() {} };
    }
  }
  return { Exec };
});

const { execInPod } = await import("../../src/pod-exec.js");

const KC = {} as never;

describe("execInPod stdout cap", () => {
  it("fails closed when pod stdout exceeds the cap", async () => {
    scriptedExec = (stdout) => {
      // Emit more than the cap in a single chunk; the host must reject.
      stdout.write(Buffer.alloc(64, 0x41));
    };
    await expect(
      execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000, 16),
    ).rejects.toThrow(/cap|exceeded/i);
  });

  it("accepts stdout within the cap and returns the accumulated output", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.from("hello", "utf-8"));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
      1024,
    );
    expect(result).toEqual({ exitCode: 0, stdout: "hello", stderr: "" });
  });

  it("leaves stdout unbounded when no cap is provided", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.alloc(4096, 0x42));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(4096);
  });
});

describe("execInPod stderr cap", () => {
  it("fails closed when pod stderr exceeds the cap", async () => {
    // stderr is equally pod-controlled: a malicious pod that floods stderr must
    // not grow the host accumulator without bound. Same DoS class as stdout.
    scriptedExec = (_stdout, stderr) => {
      stderr.write(Buffer.alloc(64, 0x45));
    };
    await expect(
      // maxStdoutBytes generous, maxStderrBytes = 16 -> stderr must trip.
      execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000, 1024, 16),
    ).rejects.toThrow(/stderr.*cap|cap.*stderr|exceeded/i);
  });

  it("accepts stderr within the cap and returns the accumulated output", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stderr.write(Buffer.from("warn", "utf-8"));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
      1024,
      1024,
    );
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "warn" });
  });

  it("leaves stderr unbounded when no cap is provided", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stderr.write(Buffer.alloc(4096, 0x46));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
      1024,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toHaveLength(4096);
  });
});
