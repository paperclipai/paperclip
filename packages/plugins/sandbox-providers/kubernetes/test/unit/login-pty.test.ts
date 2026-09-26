import { describe, it, expect, vi } from "vitest";
import { createLoginPtyManager } from "../../src/login-pty.js";

const HOME = "/tmp/paperclip-adapter-login/12345678-1234-1234-1234-123456789abc";
function harness() {
  const outputs: string[] = [];
  const exits: (number | null)[] = [];
  const connections: Array<{ command: string[]; tty: boolean; emit: (data: Buffer) => void; exit: (code: number | null) => void; close: ReturnType<typeof vi.fn>; writes: string[] }> = [];
  const manager = createLoginPtyManager(async (_scope, command, io) => {
    const connection = { command, tty: io.tty, emit: io.output, exit: io.exit, close: vi.fn(), writes: [] as string[] };
    connections.push(connection);
    return { write: (data: string) => { connection.writes.push(data); }, close: connection.close };
  }, { output: (_route, _id, data) => outputs.push(data), exit: (_route, _id, code) => exits.push(code) });
  manager.remember("lease", { companyId: "co", environmentId: "env", namespace: "ns", podName: "pod", config: { inCluster: true } });
  const request = { hostRouteId: "route", driverKey: "kubernetes", companyId: "co", environmentId: "env", providerLeaseId: "lease", loginCommandKey: "claude" as const, sessionHome: HOME };
  return { manager, connections, outputs, exits, request };
}

describe("Kubernetes login PTY", () => {
  it("opens an actual TTY with only the fixed Claude command, and routes output and delayed input", async () => {
    const h = harness();
    const { workerSessionId } = await h.manager.open(h.request);
    expect(h.connections[0].tty).toBe(true);
    expect(h.connections[0].command).toEqual(["/bin/sh", "-c", `mkdir -p '${HOME}' && exec claude setup-token`]);
    h.connections[0].emit(Buffer.from("prompt"));
    await h.manager.input({ workerSessionId, data: "code\r" });
    expect(h.outputs).toEqual(["prompt"]);
    expect(h.connections[0].writes).toEqual(["code\r"]);
    h.connections[0].exit(0);
    expect(h.exits).toEqual([0]);
    expect(h.connections[0].writes).toEqual(["code\r"]);
  });

  it("rejects invalid descriptors, unknown leases, and wrong ownership before exec", async () => {
    const h = harness();
    await expect(h.manager.open({ ...h.request, loginCommandKey: "sh" as never })).rejects.toThrow(/rejected/i);
    await expect(h.manager.open({ ...h.request, sessionHome: `${HOME};id` })).rejects.toThrow(/rejected/i);
    await expect(h.manager.open({ ...h.request, companyId: "other" })).rejects.toThrow(/lease/i);
    await expect(h.manager.open({ ...h.request, providerLeaseId: "unknown" })).rejects.toThrow(/lease/i);
    expect(h.connections).toHaveLength(0);
  });

  it("refuses to open a login on a bounded lease past its attested expiry", async () => {
    const h = harness();
    const scope = { companyId: "co", environmentId: "env", namespace: "ns", podName: "pod", config: { inCluster: true } };
    h.manager.remember("lease", { ...scope, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await expect(h.manager.open(h.request)).rejects.toThrow(/expired/i);
    h.manager.remember("lease", { ...scope, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await expect(h.manager.open(h.request)).resolves.toHaveProperty("workerSessionId");
    expect(h.connections).toHaveLength(1);
  });

  it("uses fixed Codex and Grok commands with session-scoped homes", async () => {
    for (const [key, line] of [["codex", `exec env CODEX_HOME='${HOME}' codex login --device-auth`], ["grok", `exec env GROK_HOME='${HOME}' grok login --device-auth`]] as const) {
      const h = harness();
      await h.manager.open({ ...h.request, loginCommandKey: key });
      expect(h.connections[0].command[2]).toBe(`mkdir -p '${HOME}' && ${line}`);
    }
  });

  it("reserves routes during asynchronous open and cancels a close racing the connection", async () => {
    let finish!: (value: { write(data: string): void; close(): void }) => void;
    const closes = vi.fn();
    const manager = createLoginPtyManager(() => new Promise((resolve) => { finish = resolve; }), { output: vi.fn(), exit: vi.fn() });
    manager.remember("lease", { companyId: "co", environmentId: "env", namespace: "ns", podName: "pod", config: { inCluster: true } });
    const req = harness().request;
    const opening = manager.open(req);
    await expect(manager.open(req)).rejects.toThrow(/route/i);
    await expect(manager.close({ hostRouteId: req.hostRouteId })).resolves.toEqual({ hostRouteId: req.hostRouteId });
    finish({ write: vi.fn(), close: closes });
    await expect(opening).rejects.toThrow(/cancel/i);
    expect(closes).toHaveBeenCalledOnce();
  });

  it("notifies the host when lease teardown cancels a live login", async () => {
    const h = harness();
    await h.manager.open(h.request);
    h.manager.forget("lease");
    expect(h.exits).toEqual([null]);
    expect(h.connections[0].close).toHaveBeenCalledOnce();
  });

  it("caps concurrent routes per company rather than opening unlimited WebSockets", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) await h.manager.open({ ...h.request, hostRouteId: `route-${i}` });
    await expect(h.manager.open({ ...h.request, hostRouteId: "overflow" })).rejects.toThrow(/limit/i);
    expect(h.connections).toHaveLength(4);
  });

  it("does not let one company's sessions starve another company's login attempts", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) await h.manager.open({ ...h.request, hostRouteId: `route-${i}` });
    await expect(h.manager.open({ ...h.request, hostRouteId: "overflow" })).rejects.toThrow(/limit/i);
    h.manager.remember("lease-other", { companyId: "other-co", environmentId: "env", namespace: "ns", podName: "pod", config: { inCluster: true } });
    const otherRequest = { ...h.request, providerLeaseId: "lease-other", companyId: "other-co", hostRouteId: "other-route" };
    await expect(h.manager.open(otherRequest)).resolves.toEqual({ workerSessionId: expect.any(String) });
    expect(h.connections).toHaveLength(5);
  });

  it("bounds output and input, stops and tears down only matching lease sessions", async () => {
    const h = harness();
    const { workerSessionId } = await h.manager.open(h.request);
    await expect(h.manager.input({ workerSessionId, data: "x".repeat(65537) })).rejects.toThrow(/input/i);
    h.connections[0].emit(Buffer.alloc(65537, 65));
    expect(h.outputs).toEqual([]);
    expect(h.connections[0].writes).toContain("\u0003");
    expect(h.connections[0].close).toHaveBeenCalled();
    expect(h.exits).toEqual([null]);
    await h.manager.input({ workerSessionId, data: "late" });
    expect(h.connections[0].writes).not.toContain("late");
    await h.manager.close({ hostRouteId: "route" });
    await h.manager.close({ hostRouteId: "route" });
    expect(h.connections[0].close).toHaveBeenCalledOnce();
    const other = await h.manager.open({ ...h.request, hostRouteId: "other" });
    await h.manager.stop({ workerSessionId: other.workerSessionId });
    expect(h.connections[1].writes).toEqual(["\u0003"]);
    h.manager.forget("lease");
    expect(h.connections[1].close).toHaveBeenCalledOnce();
    expect(h.exits.at(-1)).toBe(null);
    await expect(h.manager.open(h.request)).rejects.toThrow(/lease/i);
  });
});
