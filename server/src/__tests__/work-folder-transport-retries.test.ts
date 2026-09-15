import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { JsonRpcCallError } from "@paperclipai/plugin-sdk/protocol";
import { workFolderTransport } from "../services/work-folder-transport.js";

const clock = vi.hoisted(() => ({ now: 0, delay: vi.fn() }));
vi.mock("node:timers/promises", async (original) => ({
  ...await original<typeof import("node:timers/promises")>(),
  setTimeout: clock.delay,
}));

type Command = Parameters<CommandManagedRuntimeRunner["execute"]>[0];
type Transport = ReturnType<typeof workFolderTransport>;
const root = "/home/daytona/task";
const bytes = Buffer.from("verified file bytes\n");
const entry = { path: "nested/file", kind: "file" as const, byteSize: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), executable: true };
const request = (input: Command) => JSON.parse(Buffer.from(input.args!.at(-1)!, "base64").toString());
const result = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0, signal: null, timedOut: false });
const operations = ["scan", "read", "read-batch"] as const;
type Operation = typeof operations[number];

function successfulCommand(input: Command) {
  const decoded = request(input);
  expect(decoded.root).toBe(root);
  if (decoded.operation === "scan") return result([entry]);
  if (decoded.operation === "read") {
    expect(decoded.path).toBe(entry.path);
    return result({ data: bytes.subarray(decoded.offset, decoded.offset + decoded.length).toString("base64") });
  }
  expect(decoded.operation).toBe("read-batch");
  expect(decoded.entries).toEqual([{ path: entry.path, byteSize: bytes.length }]);
  return result([{ data: bytes.toString("base64") }]);
}

async function consume(transport: Transport, operation: Operation) {
  if (operation === "scan") return transport.scan(root);
  if (operation === "read-batch") return transport.readBatch!(root, [entry]);
  const chunks: Buffer[] = [];
  for await (const chunk of transport.read(root, entry.path, bytes.length)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const transientErrors = [
  { label: "typed HTTP 502", make: () => Object.assign(new Error("provider unavailable"), { response: { status: 502 } }) },
  { label: "typed HTTP 503", make: () => Object.assign(new Error("provider unavailable"), { status: 503 }) },
  { label: "typed HTTP 504", make: () => Object.assign(new Error("provider unavailable"), { statusCode: 504 }) },
  { label: "staging plugin RPC HTTP 502", make: () => new JsonRpcCallError({ code: -32002,
    message: "Request failed with status code 502: Sandbox command requested here" }) },
];

describe("work folder read transport retry boundaries", () => {
  beforeEach(() => {
    clock.now = 1_000_000;
    clock.delay.mockReset().mockImplementation(async (ms: number) => { clock.now += ms; });
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  describe.each(operations)("%s", (operation) => {
    it.each(transientErrors)("recovers $label without changing the read or duplicating bytes", async ({ make }) => {
      const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>()
        .mockRejectedValueOnce(make()).mockRejectedValueOnce(make()).mockImplementation(async (input) => successfulCommand(input));
      const transport = workFolderTransport({ execute, supportsSingleStreamStdinProgress: true });
      const received = await consume(transport, operation);
      expect(received).toEqual(operation === "scan" ? [entry] : operation === "read-batch" ? [bytes] : bytes);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute.mock.calls.map(([input]) => request(input))).toEqual(Array(3).fill(request(execute.mock.calls[0]![0])));
      expect(execute.mock.calls.map(([input]) => input.timeoutMs)).toEqual([120_000, 119_750, 119_250]);
      expect(clock.delay.mock.calls).toEqual([[250], [500]]);
    });

    it("returns the last transport error after three failed attempts", async () => {
      const errors = transientErrors.slice(0, 3).map(({ make }) => make());
      const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>()
        .mockRejectedValueOnce(errors[0]).mockRejectedValueOnce(errors[1]).mockRejectedValueOnce(errors[2]);
      await expect(consume(workFolderTransport({ execute, supportsSingleStreamStdinProgress: true }), operation)).rejects.toBe(errors[2]);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(clock.delay).toHaveBeenCalledTimes(2);
    });

    it("does not schedule a retry whose backoff exceeds the shared 120-second budget", async () => {
      const error = transientErrors[0]!.make();
      const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>().mockImplementation(async () => {
        clock.now += 119_900;
        throw error;
      });
      await expect(consume(workFolderTransport({ execute, supportsSingleStreamStdinProgress: true }), operation)).rejects.toBe(error);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(clock.delay).not.toHaveBeenCalled();
    });
  });

  it("subtracts elapsed provider time from later attempts instead of resetting the deadline", async () => {
    const error = transientErrors[3]!.make();
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>().mockImplementation(async (input) => {
      clock.now += execute.mock.calls.length === 1 ? 119_000 : input.timeoutMs!;
      throw error;
    });
    await expect(workFolderTransport({ execute }).scan(root)).rejects.toBe(error);
    expect(execute.mock.calls.map(([input]) => input.timeoutMs)).toEqual([120_000, 750]);
    expect(clock.now).toBe(1_120_000);
    expect(clock.delay.mock.calls).toEqual([[250]]);
  });

  it.each([
    { label: "HTTP 401", error: Object.assign(new Error("denied"), { response: { status: 401 } }) },
    { label: "HTTP 403", error: Object.assign(new Error("denied"), { status: 403 }) },
    { label: "plain error with the staging text", error: new Error("Request failed with status code 502: Sandbox command requested here") },
    { label: "different RPC error code", error: new JsonRpcCallError({ code: -32603, message: "Request failed with status code 502" }) },
    { label: "arbitrary RPC command error containing 502", error: new JsonRpcCallError({ code: -32002, message: "script failed: Request failed with status code 502" }) },
    { label: "unrecognized RPC suffix", error: new JsonRpcCallError({ code: -32002, message: "Request failed with status code 502: application rejected path" }) },
    { label: "RPC authorization denial", error: new JsonRpcCallError({ code: -32002, message: "Request failed with status code 403: Sandbox command requested here" }) },
  ])("does not retry $label", async ({ error }) => {
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>().mockRejectedValue(error);
    await expect(workFolderTransport({ execute }).scan(root)).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(clock.delay).not.toHaveBeenCalled();
  });

  it.each([
    { label: "script failure", response: { ...result([]), exitCode: 1, stderr: "path_conflict: HTTP 502" } },
    { label: "command timeout", response: { ...result([]), timedOut: true } },
    { label: "invalid JSON", response: { ...result([]), stdout: "not json" } },
    { label: "invalid scan paths", response: result([{ ...entry, path: "../outside" }]) },
  ])("preserves $label as a non-retryable failure", async ({ response }) => {
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>().mockResolvedValue(response);
    await expect(workFolderTransport({ execute }).scan(root)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(clock.delay).not.toHaveBeenCalled();
  });

  it("does not replay a root move after a typed HTTP 503 with an uncertain outcome", async () => {
    const error = transientErrors[1]!.make();
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>().mockRejectedValue(error);
    await expect(workFolderTransport({ execute }).moveRoot("/old", root)).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(request(execute.mock.calls[0]![0]).operation).toBe("move-root");
    expect(clock.delay).not.toHaveBeenCalled();
  });
});
