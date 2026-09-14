import { describe, expect, it, vi } from "vitest";
import { controlRemoteProcess, type RemoteProcessControlOperation } from "./remote-process-control.js";
import type { RemoteProcessIdentity } from "./remote-process-identity.js";

const owner: RemoteProcessIdentity = { version: 1, pid: 1234, processGroupId: 1234, uid: 1000,
  startTicks: "56789", bootId: "676f2b7a-a6dc-4111-8e54-aabbccddeeff" };
const result = { pid: null, startedAt: "2026-09-13T00:00:00.000Z", exitCode: 0, timedOut: false, signal: null, stdout: '{"state":"exited"}', stderr: "" };

describe("remote kernel process control protocol", () => {
  it("uses only the trusted identity through the original command runner", async () => {
    const execute = vi.fn(async () => result);
    expect(await controlRemoteProcess({ execute }, owner, { action: "inspect" })).toBe("exited");
    expect(execute).toHaveBeenCalledOnce();
    const call = execute.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0]).toMatchObject({ command: "node", bypassSession: true, timeoutMs: 10_000,
      env: { PAPERCLIP_REMOTE_PROCESS_CONTROL: JSON.stringify({ owner, operation: { action: "inspect" } }), NODE_OPTIONS: "", NODE_PATH: "" } });
  });

  it.each([
    { timedOut: true }, { exitCode: 1 }, { stdout: "untrusted output" },
    { stdout: '{"state":"exited","secret":"must not be accepted"}' },
    { stdout: '{"state":"stopped"}' }, { stdout: '"exited"' },
    { stdout: "null" }, { stdout: "x".repeat(129) },
  ])("does not infer an exit from invalid provider output: %j", async patch => {
    const execute = vi.fn(async () => ({ ...result, ...patch }));
    expect(await controlRemoteProcess({ execute }, owner, { action: "inspect" })).toBe("unverified");
  });

  it("does not dispatch an invalid ownership receipt", async () => {
    const execute = vi.fn(async () => result);
    expect(await controlRemoteProcess({ execute }, { ...owner, pid: 1 }, { action: "signal", signal: "SIGKILL" })).toBe("unverified");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "signal", signal: "SIGTERM" }, "signalled"],
    [{ action: "stop_group" }, "stopped"],
  ] as [RemoteProcessControlOperation, string][])("accepts only the operation's own success state: %j", async (operation, state) => {
    const execute = vi.fn(async () => ({ ...result, stdout: JSON.stringify({ state }) }));
    expect(await controlRemoteProcess({ execute }, owner, operation)).toBe(state);
    execute.mockResolvedValue({ ...result, stdout: '{"state":"running"}' });
    expect(await controlRemoteProcess({ execute }, owner, operation)).toBe("unverified");
  });

  it("keeps a lost control RPC unverified without exposing its output", async () => {
    const execute = vi.fn(async () => { throw new Error("private provider output"); });
    expect(await controlRemoteProcess({ execute }, owner, { action: "signal", signal: "SIGKILL" })).toBe("unverified");
  });
});
