import net from "node:net";
import { mkdtempSync, mkdirSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeSocketParent, createNativePeerCredentialReader, startBrokerServer } from "../tailscale-broker/server.js";
import type { Broker, PeerIdentity } from "../tailscale-broker/broker.js";

// A minimal Broker stand-in that records the request it received.
function fakeBroker(handler: (req: unknown, peer: PeerIdentity) => Promise<unknown>): Broker {
  return { handle: handler } as unknown as Broker;
}

function testPeerReader(identity: PeerIdentity) {
  return { read: () => ({ ...identity }) };
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function request(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => client.end(payload));
    let out = "";
    client.on("data", (d) => (out += d.toString()));
    client.on("end", () => resolve(out));
    client.on("error", reject);
  });
}

describe("assertSafeSocketParent", () => {
  it("rejects a symlinked parent", () => {
    expect(() =>
      assertSafeSocketParent("/x/s.sock", { isDirectory: () => true, isSymbolicLink: () => true, mode: 0o755, uid: 0 }),
    ).toThrow(/symlink/);
  });
  it("rejects a group/world-writable parent", () => {
    expect(() =>
      assertSafeSocketParent("/x/s.sock", { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o777, uid: 0 }),
    ).toThrow(/writable/);
  });
  it("accepts a safe root-owned 0755 parent", () => {
    assertSafeSocketParent("/x/s.sock", { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o755, uid: 0 });
  });
});

describe("broker socket server (end to end)", () => {
  it("refuses to start when the parent directory is a symlink", () => {
    const base = mkdtempSync(path.join(tmpdir(), "brk-"));
    const real = path.join(base, "real");
    mkdirSync(real);
    const link = path.join(base, "link");
    symlinkSync(real, link);
    expect(() =>
      startBrokerServer({
        socketPath: path.join(link, "broker.sock"),
        broker: fakeBroker(async () => ({ ok: true, result: {} })),
        peerReader: testPeerReader({ uid: 1000, gid: 2000, pid: 123 }),
      }),
    ).toThrow(/symlink/);
  });

  it("round-trips a request and passes peer credentials through", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "brk-"));
    chmodSync(dir, 0o755);
    const socketPath = path.join(dir, "broker.sock");
    let seenPeer: PeerIdentity | null = null;
    const server = startBrokerServer({
      socketPath,
      broker: fakeBroker(async (_req, peer) => {
        seenPeer = peer;
        return { ok: true, result: { leases: [] } };
      }),
      peerReader: testPeerReader({ uid: 1000, gid: 2000, pid: 123 }),
    });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const res = await request(socketPath, `${JSON.stringify({ v: 1, op: "list" })}\n`);
    expect(JSON.parse(res)).toEqual({ ok: true, result: { leases: [] } });
    expect(seenPeer).toEqual({ uid: 1000, gid: 2000, pid: 123 });
  });

  it("rejects an oversized request frame", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "brk-"));
    chmodSync(dir, 0o755);
    const socketPath = path.join(dir, "broker.sock");
    const server = startBrokerServer({
      socketPath,
      broker: fakeBroker(async () => ({ ok: true, result: {} })),
      peerReader: testPeerReader({ uid: 1000, gid: 2000, pid: 123 }),
    });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const res = await request(socketPath, `${" ".repeat(9000)}\n`);
    expect(JSON.parse(res)).toMatchObject({ ok: false, code: "frame_too_large" });
  });

  it("reads the connecting process identity from the native socket binding", () => {
    const getPeerCredentials = vi.fn(() => ({ uid: 1234, gid: 2345, pid: 3456 }));
    const reader = createNativePeerCredentialReader(() => ({ getPeerCredentials }));
    const socket = { _handle: { fd: 17 } } as unknown as net.Socket;

    expect(reader.read(socket)).toEqual({ uid: 1234, gid: 2345, pid: 3456 });
    expect(getPeerCredentials).toHaveBeenCalledWith(17);
  });

  it("fails closed when the native socket binding returns invalid credentials", () => {
    const reader = createNativePeerCredentialReader(() => ({
      getPeerCredentials: () => ({ uid: 1234, gid: 2345, pid: null }),
    }));
    const socket = { _handle: { fd: 17 } } as unknown as net.Socket;

    expect(reader.read(socket)).toBeNull();
  });

  it("reports a fatal startup error when the socket cannot bind", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "brk-"));
    chmodSync(dir, 0o755);
    const socketPath = path.join(dir, "broker.sock");
    const first = startBrokerServer({
      socketPath,
      broker: fakeBroker(async () => ({ ok: true, result: {} })),
      peerReader: testPeerReader({ uid: 1000, gid: 2000, pid: 123 }),
    });
    servers.push(first);
    await new Promise((resolve) => first.once("listening", resolve));

    const fatal = new Promise<Error>((resolve) => {
      startBrokerServer({
        socketPath,
        broker: fakeBroker(async () => ({ ok: true, result: {} })),
        peerReader: testPeerReader({ uid: 1000, gid: 2000, pid: 123 }),
        onError: () => undefined,
        onFatal: resolve,
      });
    });

    await expect(fatal).resolves.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("systemd deployment", () => {
  it("gives the broker owner write access without making the socket directory group-writable", () => {
    const unit = readFileSync(
      new URL("../../../docs/deploy/paperclip-tailscale-broker.service", import.meta.url),
      "utf8",
    );
    expect(unit).toContain("User=pcts-broker");
    expect(unit).toContain("Group=paperclip");
    expect(unit).toContain("RuntimeDirectory=paperclip-tailscale-broker");
    expect(unit).toContain("RuntimeDirectoryMode=0750");
  });
});
