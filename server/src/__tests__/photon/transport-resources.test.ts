import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createSecureServer, type ServerHttp2Session } from "node:http2";
import type { GrpcAdvancedIMessage } from "@photon-ai/advanced-imessage";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PhotonTransportResources } from "../../services/photon/transport-resources.js";

const observed = vi.hoisted(() => ({ rows: new Map<object, { kind: string; closed: boolean; close: () => void }>() }));
vi.mock("@photon-ai/advanced-imessage", async importOriginal => {
  const sdk = await importOriginal<typeof import("@photon-ai/advanced-imessage")>();
  const { PhotonTransportResources: Owner } = await import("../../services/photon/transport-resources.js");
  return { ...sdk, createGrpcClient: (options: Parameters<typeof sdk.createGrpcClient>[0]) => {
    const owner: unknown = Reflect.get(options.channelOptions ?? {}, "grpc-node.transport_owner");
    if (!(owner instanceof Owner)) throw new Error("actual SDK transport owner absent");
    const record = (kind: string, resource: Parameters<InstanceType<typeof Owner>["socket"]>[0] | Parameters<InstanceType<typeof Owner>["session"]>[0] | Parameters<InstanceType<typeof Owner>["request"]>[0]) => {
      let row = observed.rows.get(resource);
      if (!row) {
        const current = { kind, closed: false, close: () => {} };
        current.close = () => { current.closed = true; };
        row = current; observed.rows.set(resource, row);
      }
      // grpc may report the SAME object after removing transition listeners.
      if (!row.closed && !resource.listeners("close").includes(row.close)) resource.once("close", row.close);
    };
    const socket = owner.socket, session = owner.session, request = owner.request;
    vi.spyOn(owner, "socket").mockImplementation(resource => { record("socket", resource); socket(resource); });
    vi.spyOn(owner, "session").mockImplementation(resource => { record("session", resource); session(resource); });
    vi.spyOn(owner, "request").mockImplementation(resource => { record("request", resource); request(resource); });
    return sdk.createGrpcClient(options); // Actual SDK, channels, TLS and request, never a fabricated RPC result.
  } };
});
let directory: string, certificate: Buffer, key: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "photon-tls-"));
  const cert = join(directory, "cert.pem"), privateKey = join(directory, "key.pem");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", privateKey, "-out", cert]);
  certificate = await readFile(cert); key = await readFile(privateKey);
  vi.stubEnv("GRPC_DEFAULT_SSL_ROOTS_FILE_PATH", cert);
}, 30_000);
afterAll(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

// One absolute case budget: work must reach cleanup by 10s; cleanup ends by
// 14s, inside the existing 15s Vitest cap. A Vitest timeout is not a finally.
async function bounded<T>(work: PromiseLike<T>, deadline: number, label: string): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error(`TLS proof ${label} exhausted its existing case budget`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TLS proof ${label} did not join within its existing case budget`)), remaining);
  })]); } finally { if (timer) clearTimeout(timer); }
}

for (const viaProxy of [false, true]) it(`joins actual TLS HTTP2 SDK resources${viaProxy ? " through a local CONNECT proxy" : " directly"}`, async () => {
  const started = performance.now(), workUntil = started + 10_000, cleanupUntil = started + 14_000;
  observed.rows.clear();
  const peers = new Map<Socket, Promise<void>>(), sessions = new Map<ServerHttp2Session, Promise<void>>();
  const listeners: (ReturnType<typeof createSecureServer> | ReturnType<typeof createServer>)[] = [];
  let client: GrpcAdvancedIMessage | undefined;
  let operation: Promise<{ unexpectedSuccess: true } | { error: unknown }> | undefined;
  let primary: unknown; const cleanup: unknown[] = [];
  const recordPeer = (socket: Socket) => { if (!peers.has(socket)) {
    socket.on("error", () => {}); peers.set(socket, new Promise<void>(resolve => socket.once("close", () => resolve())));
  } };
  try {
    const server = createSecureServer({ key, cert: certificate }); listeners.push(server);
    server.on("connection", recordPeer); server.on("secureConnection", recordPeer);
    server.on("session", session => { session.on("error", () => {});
      sessions.set(session, new Promise<void>(resolve => session.once("close", () => resolve()))); });
    let entered!: () => void; const requested = new Promise<void>(resolve => { entered = resolve; });
    server.on("stream", stream => { stream.on("error", () => {}); entered(); }); // Real held RPC; no fabricated result.
    const listening = once(server, "listening"); server.listen(0, "127.0.0.1");
    await bounded(listening, workUntil, "TLS listen");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("TLS listener absent");
    let connects = 0; const proxyErrors: Error[] = [];
    const proxy = createServer(); listeners.push(proxy); proxy.on("connection", recordPeer);
    proxy.on("connect", (request, downstream, head) => {
      connects++;
      if (request.url !== `127.0.0.1:${address.port}`) {
        proxyErrors.push(new Error("CONNECT target differs from exact owned TLS listener")); downstream.destroy(); return;
      }
      const upstream = connect(address.port, "127.0.0.1"); recordPeer(upstream);
      upstream.once("connect", () => { downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head); downstream.pipe(upstream); upstream.pipe(downstream); });
      downstream.once("close", () => upstream.destroy()); upstream.once("close", () => downstream.destroy());
    });
    for (const name of ["grpc_proxy", "https_proxy", "http_proxy", "no_grpc_proxy", "no_proxy"]) vi.stubEnv(name, "");
    if (viaProxy) {
      const listening = once(proxy, "listening"); proxy.listen(0, "127.0.0.1"); await bounded(listening, workUntil, "CONNECT listen");
      const address = proxy.address(); if (!address || typeof address === "string") throw new Error("CONNECT listener absent");
      vi.stubEnv("grpc_proxy", `http://127.0.0.1:${address.port}`);
    }
    const { createOwnedPhotonClient } = await bounded(import("../../services/photon/owned-client.js"), workUntil, "SDK import");
    client = createOwnedPhotonClient({ address: `127.0.0.1:${address.port}`, token: "controlled", tls: true, retry: false,
      channelOptions: { "grpc.ssl_target_name_override": "localhost" } }); // Preserve normal SDK deadline; prove CLOSE, not expiry.
    operation = client.chats.get("any;-;+15555550100").then(() => ({ unexpectedSuccess: true as const }), error => ({ error }));
    await bounded(Promise.race([requested, operation.then(result => { if ("error" in result) throw result.error; throw new Error("actual RPC succeeded before held TLS HTTP2 request entry"); })]), workUntil, "actual RPC entry");
    expect(proxyErrors).toEqual([]);
    expect([...observed.rows.values()].some(row => row.kind === "socket")).toBe(true);
    expect([...observed.rows.keys()].some(resource => Reflect.get(resource, "encrypted") === true)).toBe(true);
    expect([...observed.rows.values()].some(row => row.kind === "session")).toBe(true);
    expect(sessions.size).toBeGreaterThan(0);
    if (viaProxy) { expect(connects).toBeGreaterThan(0); expect([...observed.rows.values()].some(row => row.kind === "request")).toBe(true); }
    await bounded(client.close(), workUntil, "normal owner close");
    expect(await bounded(operation, workUntil, "actual RPC cancellation")).toHaveProperty("error");
    expect([...observed.rows.values()].every(row => row.closed)).toBe(true);
    await bounded(Promise.all([...peers.values(), ...sessions.values()]), workUntil, "every actual peer/session close");
    // PASS requires all real receipts ABOVE, before forced finally cleanup.
  } catch (error) { primary = error; }
  finally {
    const joins: { label: string; work: PromiseLike<unknown> }[] = [];
    if (client) try { joins.push({ label: "client cleanup", work: client.close() }); } catch (error) { cleanup.push(error); }
    for (const resource of observed.rows.keys()) try {
      const destroy: unknown = Reflect.get(resource, "destroy");
      if (typeof destroy === "function") Reflect.apply(destroy, resource, []);
    } catch (error) { cleanup.push(error); }
    for (const peer of peers.keys()) try { peer.destroy(); } catch (error) { cleanup.push(error); }
    for (const session of sessions.keys()) try { session.destroy(); } catch (error) { cleanup.push(error); }
    if (operation) joins.push({ label: "RPC cleanup", work: operation });
    joins.push({ label: "peer/session cleanup", work: Promise.all([...peers.values(), ...sessions.values()]) });
    // Start EVERY listener close before awaiting any one cleanup promise.
    for (const listener of listeners) if (listener.listening) joins.push({ label: "listener cleanup", work: new Promise<void>((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve());
    }) });
    // Attach handlers to every started join before the first await; all errors remain visible.
    const results = joins.map(({ label, work }) => bounded(work, cleanupUntil, label).then(() => undefined, error => error));
    for (const result of results) { const error = await result; if (error !== undefined) cleanup.push(error); }
  }
  if (primary || cleanup.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanup], "TLS owner proof or exact cleanup failed");
}, 15_000);

it("refuses a close receipt while an exact real socket refuses disposal", async () => {
  const started = performance.now(), workUntil = started + 3000, cleanupUntil = started + 4500;
  let server: ReturnType<typeof createServer> | undefined, socket: Socket | undefined, peer: Socket | undefined;
  let destroy: { mockRestore(): void } | undefined;
  let closed: Promise<void> | undefined, primary: unknown;
  const cleanup: unknown[] = [];
  try {
    server = createServer(); const listening = once(server, "listening"); server.listen(0, "127.0.0.1");
    await bounded(listening, workUntil, "negative listen");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("negative listener absent");
    const peerConnected = new Promise<Socket>(resolve => server!.once("connection", resolve));
    socket = connect(address.port, "127.0.0.1"); socket.on("error", () => {});
    closed = new Promise<void>(resolve => socket!.once("close", () => resolve()));
    peer = await bounded(peerConnected, workUntil, "negative real socket entry"); peer.on("error", () => {});
    const owner = new PhotonTransportResources(); owner.socket(socket);
    const refusal = new Error("controlled exact real socket disposal refusal");
    destroy = vi.spyOn(socket, "destroy").mockImplementation(() => { throw refusal; });
    await expect(bounded(owner.close(), workUntil, "negative refusal")).rejects.toMatchObject({ message: "Photon transport disposal remains incomplete", errors: [refusal] });
    expect(socket.destroyed).toBe(false); // Refused disposal is debt, not a close receipt.
    destroy.mockRestore(); destroy = undefined;
    await bounded(owner.close(), workUntil, "same exact socket retry"); await bounded(closed, workUntil, "negative actual close");
  } catch (error) { primary = error; }
  finally {
    destroy?.mockRestore();
    try { socket?.destroy(); peer?.destroy(); } catch (error) { cleanup.push(error); }
    const joins: PromiseLike<unknown>[] = [];
    if (closed) joins.push(closed);
    if (server?.listening) joins.push(new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())));
    const results = joins.map(work => bounded(work, cleanupUntil, "negative cleanup").then(() => undefined, error => error));
    for (const result of results) { const error = await result; if (error !== undefined) cleanup.push(error); }
  }
  if (primary || cleanup.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanup], "negative socket proof or cleanup failed");
}, 5_000);
