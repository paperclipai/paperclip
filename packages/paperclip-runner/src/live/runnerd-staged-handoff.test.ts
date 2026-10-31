import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
  DurablePrpControlPlane, inspectStagedRunAttachmentHeader,
  type DurablePrpCheckpoint, type RunnerProcessConnection, type PrpWireConnection,
} from "../control-plane/durable-prp-control-plane.js";
import {
  createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary,
  readRunnerdArtifactBinding,
} from "./runnerd-codex-transport.js";

// The guest rejects WebSocket extensions. Use the same uncompressed wire
// contract as production, without importing the server connector into Runner.
async function openOwnedWire(url: string): Promise<{ wire: PrpWireConnection; closed: Promise<void>; close(): void }> {
  return new Promise((resolvePeer, reject) => {
    const key = randomBytes(16).toString("base64");
    const req = request(url.replace("ws:", "http:"), { headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
    } });
    req.on("error", reject); req.on("response", response => { response.resume(); reject(new Error(`Guest upgrade refused: ${response.statusCode}`)); });
    req.setTimeout(1_000, () => req.destroy(new Error("Guest upgrade timeout")));
    req.on("upgrade", (response, socket, head) => {
      socket.setTimeout(0);
      const expected = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      if (response.headers["sec-websocket-accept"] !== expected) { socket.destroy(); reject(new Error("Invalid guest upgrade")); return; }
      const listeners: Array<(value: unknown) => void> = [], closes: Array<() => void> = [];
      let buffer: Buffer = head, ended = false;
      let closeResolve!: () => void;
      const closed = new Promise<void>(done => { closeResolve = done; });
      const finish = () => { if (ended) return; ended = true; for (const close of closes) close(); closeResolve(); };
      const send = (payload: Buffer, opcode: number) => {
        const mask = randomBytes(4), prefix = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length]) : Buffer.alloc(payload.length <= 65535 ? 4 : 10);
        if (payload.length >= 126) { prefix[0] = 0x80 | opcode; prefix[1] = 0x80 | (payload.length <= 65535 ? 126 : 127);
          if (payload.length <= 65535) prefix.writeUInt16BE(payload.length, 2); else prefix.writeBigUInt64BE(BigInt(payload.length), 2); }
        const masked = Buffer.from(payload); for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4]!;
        socket.write(Buffer.concat([prefix, mask, masked]));
      };
      const parse = () => {
        while (buffer.length >= 2) {
          const opcode = buffer[0]! & 15, initial = buffer[1]! & 127;
          if (buffer.length < (initial === 126 ? 4 : initial === 127 ? 10 : 2)) return;
          const size = initial === 126 ? buffer.readUInt16BE(2) : initial === 127 ? Number(buffer.readBigUInt64BE(2)) : initial;
          const offset = initial === 126 ? 4 : initial === 127 ? 10 : 2;
          if (buffer.length < offset + size) return;
          // Upgrade head bytes can precede the caller's message subscription.
          // Retain complete data frames until the control-plane listener exists.
          if ((opcode === 1 || opcode === 2) && listeners.length === 0) return;
          const payload = buffer.subarray(offset, offset + size); buffer = buffer.subarray(offset + size);
          if (opcode === 8) { socket.destroy(); finish(); return; }
          if (opcode === 9) send(payload, 10);
          if (opcode === 1 || opcode === 2) for (const listener of listeners) listener(JSON.parse(payload.toString("utf8")));
        }
      };
      socket.on("data", bytes => { buffer = Buffer.concat([buffer, bytes]); parse(); }); socket.on("close", finish); socket.on("error", finish);
      const close = () => { socket.destroy(); finish(); };
      resolvePeer({ wire: { sendJson: value => send(Buffer.from(JSON.stringify(value)), 1), close,
        onJson: listener => { listeners.push(listener); parse(); }, onClose: listener => { closes.push(() => listener({})); } }, closed, close });
      queueMicrotask(parse);
    }); req.end();
  });
}

it("delivers a WebSocket message coalesced with the real HTTP upgrade response", async () => {
  const message = { type: "hello", sentinel: "coalesced-upgrade" };
  const server = createServer();
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const payload = Buffer.from(JSON.stringify(message));
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      Buffer.from([0x81, payload.length]), payload]));
  });
  let peer: Awaited<ReturnType<typeof openOwnedWire>> | undefined;
  const messages: unknown[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing coalesced-upgrade endpoint");
    peer = await openOwnedWire(`ws://127.0.0.1:${address.port}/`);
    peer.wire.onJson(value => messages.push(value));
    await vi.waitFor(() => expect(messages).toEqual([message]), { timeout: 1000 });
  } finally {
    peer?.close();
    const closing = server.listening
      ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      : Promise.resolve();
    for (const socket of sockets) socket.destroy();
    await closing;
  }
});

// Real encrypted PRP and real Runner/provider processes; no model or server imports.
it.each(["connect", "listen"] as const)("recovers a staged %s handoff at every durable boundary without another process", async mode => {
  const root = await mkdtemp(join(tmpdir(), "runner-staged-handoff-"));
  const shared = join(root, "shared"), calls = join(root, "calls.log");
  const source = { runnerInstanceId: "runner-staged", environmentLeaseId: "lease-staged", runId: "source-run",
    normalizedSessionId: "session-staged", turnId: "source-turn", itemId: "source-item" };
  const target = { ...source, runId: "target-run", turnId: "target-turn", itemId: "target-item" };
  const http = createServer();
  const routes = new Map<string, { core: DurablePrpControlPlane; token: symbol }>();
  http.on("upgrade", (request, socket, head) => {
    const route = routes.get(request.url ?? "");
    if (route) route.core.handleUpgrade(request, socket, request.url!, head); else socket.destroy();
  });
  await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing owned endpoint");
  const guest = createServer();
  await new Promise<void>(done => guest.listen(0, "127.0.0.1", done));
  const guestAddress = guest.address();
  if (!guestAddress || typeof guestAddress === "string") throw new Error("Missing owned guest endpoint");
  const guestPort = guestAddress.port;
  await new Promise<void>(done => guest.close(() => done()));
  const within = async <T>(promise: Promise<T>, label: string, ms = 8_000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`staged fixture timeout: ${label}`)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
  // Each boundary uses a fresh company-free fixture so no previous command or
  // activation can satisfy a later assertion.
  try {
    for (const boundary of ["queued", "prepared", "activated", "completed"] as const) {
      const directory = join(shared, boundary), callLog = `${calls}-${boundary}`;
      let checkpoint!: DurablePrpCheckpoint, currentCore!: DurablePrpControlPlane;
      let lost = false, release!: () => void, reached!: () => void;
      const held = new Promise<void>(done => { release = done; });
      const atBoundary = new Promise<void>(done => { reached = done; });
      const cores = new Set<DurablePrpControlPlane>();
      const registered = new WeakSet<DurablePrpControlPlane>();
      let generation = 0;
      const registration = async (core: DurablePrpControlPlane, identity = core.store.state.identity) => {
        currentCore = core;
        if (!registered.has(core)) {
          registered.add(core); cores.add(core);
          const epoch = generation;
          core.setCheckpointPersistence(async saved => {
            if (epoch !== generation) throw new Error("retired fixture controller");
            checkpoint = saved;
            const proof = inspectStagedRunAttachmentHeader(saved.records.get("header")!);
            if (!lost && proof?.phase === (boundary === "queued" ? "attachment_queued" : boundary)) {
              lost = true; reached(); await held;
              if (epoch !== generation) throw new Error("retired fixture controller");
            }
          });
        }
        const path = `/api/runner/v1/connect/${identity.runId}`, token = Symbol(path);
        const connection: RunnerProcessConnection = mode === "connect"
          ? { mode: "connect", connectUrl: `ws://127.0.0.1:${address.port}${path}` }
          : { mode: "listen", listenAddress: "0.0.0.0", listenPort: guestPort, listenPath: path };
        if (mode === "connect") {
          routes.set(path, { core, token });
          return { connection, release: () => { if (routes.get(path)?.token === token) routes.delete(path); } };
        }
        let stopped = false, socket: { close(): void } | undefined;
        let readyResolve!: () => void, readyReject!: (error: Error) => void;
        const ready = new Promise<void>((done, reject) => { readyResolve = done; readyReject = reject; });
        void ready.catch(() => undefined);
        const connect = async () => {
          const deadline = Date.now() + 8_000;
          while (!stopped && Date.now() < deadline) {
            try {
              const peer = await openOwnedWire(`ws://127.0.0.1:${guestPort}${path}`); socket = peer;
              if (stopped) { peer.close(); return; }
              core.attachWireConnection(peer.wire); readyResolve(); await peer.closed;
            } catch { /* The target listener appears only after the old receipt ACK. */ }
            // Match the production ingress connector's first retry delay (250ms).
            if (!stopped) await new Promise<void>(done => setTimeout(done, 250));
          }
          if (!stopped) readyReject(new Error("Owned listener did not become available"));
        };
        return { connection, activate: () => { void connect(); }, ready: () => ready,
          release: () => { stopped = true; socket?.close(); } };
      };
      const options = { runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
        codexArgs: ["--call-log", callLog, "--record-process-start", "--state-file", join(directory, "fake.json")],
        stateDirectory: directory, readRunnerState: async () => JSON.parse(await readFile(join(directory, "runner/runner-state.json"), "utf8")), lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
        runnerReconnectGraceMs: 5_000, prpIdentity: source, controlPlaneRegistration: registration,
        onStagedRunAttachment: async () => undefined, onRecoveryAccountingEvent: async () => undefined };
      const first = createCapabilityRunnerdCodexTransport(options);
      let replacement: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
      let runnerPid: number | null = null, providerPid: number | null = null;
      try {
        const opened = await within(first.transport.request("thread/start", { cwd: root, dynamicTools: [] }), "source open");
        runnerPid = first.evidence().runnerPid; providerPid = first.evidence().providerPid;
        const startedAt = first.transport.processInfo().startedAt;
        const providerStart = execFileSync("ps", ["-p", String(providerPid), "-o", "lstart="], { encoding: "utf8" }).trim();
        expect(runnerPid).toBeGreaterThan(0); expect(providerPid).toBeGreaterThan(0);
        const attach = first.transport.attachRun!({ runId: target.runId, turnId: target.turnId, itemId: target.itemId });
        void attach.catch(() => undefined);
        await within(atBoundary, `reach ${boundary}`);
        expect(inspectStagedRunAttachmentHeader(checkpoint.records.get("header")!)?.attachment.targetIdentity).toEqual(target);
        generation += 1;
        // Disconnect the controller only. The bounded failed commit is released
        // after its route is retired; a stale callback cannot publish generation B.
        const detached = first.detachControllerForRestart(); void detached.catch(() => undefined);
        release(); await within(detached, "detach").catch(() => undefined);
        const next = join(root, `replacement-${boundary}`);
        checkpoint.restoreSessionDirectory(next);
        const noSpawn = vi.fn(() => { throw new Error("Duplicate Runner launch"); });
        const recoveryOptions: Parameters<typeof createCapabilityRunnerdCodexTransport>[0] = { ...options, stateDirectory: next,
          prpIdentity: target, runnerArtifact: readRunnerdArtifactBinding(options.runnerBinary),
          runnerStateDirectory: join(directory, "runner"), readRunnerState: async () => JSON.parse(await readFile(join(directory, "runner/runner-state.json"), "utf8")),
          prepareExternalRunnerState: async () => { throw new Error("Verified live handoff must not restore a backup"); },
          runnerProcessLauncher: noSpawn, warmTransitionRegistrationMode: mode === "listen" ? "routed_same_endpoint" : "routed_connect",
          resumeProviderSession: { driverSessionId: String((opened.thread as { id: string }).id), providerSessionId: String((opened.thread as { sessionId: string }).sessionId) },
          adoptExistingRunner: { pid: runnerPid, processGroupId: runnerPid, startedAt,
            isAlive: () => !dead(runnerPid!), signal: signal => { if (dead(runnerPid!)) return true; process.kill(-runnerPid!, signal); return true; } } };
        if (boundary === "queued") {
          const noProof = createCapabilityRunnerdCodexTransport({ ...recoveryOptions, adoptExistingRunner: undefined });
          await expect(noProof.transport.request("thread/read", {})).rejects.toThrow("queued_attachment_requires_verified_live_source");
          await noProof.detachControllerForRestart().catch(() => undefined);
          checkpoint.restoreSessionDirectory(next);
          const wrongEndpoint = createCapabilityRunnerdCodexTransport({ ...recoveryOptions,
            controlPlaneRegistration: async (core, identity) => {
              const registered = await registration(core, identity);
              if (identity?.runId !== target.runId) return registered;
              return { ...registered, connection: mode === "listen"
                ? { mode: "listen", listenAddress: "0.0.0.0", listenPort: guestPort + 1, listenPath: `/api/runner/v1/connect/${target.runId}` }
                : { mode: "connect", connectUrl: `ws://127.0.0.1:${address.port}/changed` } };
            } });
          await expect(wrongEndpoint.transport.request("thread/read", {})).rejects.toThrow("registered_endpoint_mismatch");
          await wrongEndpoint.detachControllerForRestart().catch(() => undefined);
          expect(noSpawn).not.toHaveBeenCalled();
          checkpoint.restoreSessionDirectory(next);
        }
        replacement = createCapabilityRunnerdCodexTransport(recoveryOptions);
        const read = await within(replacement.transport.request("thread/read", {}), `recover ${boundary}`);
        expect(read.thread).toMatchObject({ id: (opened.thread as { id: string }).id,
          sessionId: (opened.thread as { sessionId: string }).sessionId });
        expect(dead(providerPid!)).toBe(false);
        expect(execFileSync("ps", ["-p", String(providerPid), "-o", "lstart="], { encoding: "utf8" }).trim()).toBe(providerStart);
        expect(replacement.evidence().runnerPid).toBe(runnerPid);
        expect(currentCore.activeRunnerConnectionCount()).toBe(1);
        expect(currentCore.store.state.identity).toEqual(target);
        expect(currentCore.store.state.stagedRunAttachment).toBeDefined();
        expect(currentCore.markStagedTargetCheckpointPublished({ ...target, itemId: "wrong" })).toBe(false);
        await currentCore.flushCheckpoint();
        const beforeMark = checkpoint;
        expect(currentCore.markStagedTargetCheckpointPublished(target)).toBe(true);
        await currentCore.flushCheckpoint(); expect(checkpoint).toBe(beforeMark);
        await within(replacement.transport.request("thread/goal/get", {}), "post-checkpoint read");
        expect(currentCore.store.state.stagedRunAttachment).toBeUndefined();
        expect(noSpawn).not.toHaveBeenCalled();
        const effects = (await readFile(callLog, "utf8")).trim().split(/\r?\n/);
        expect(effects.filter(line => line === "process-start")).toHaveLength(1);
        expect(effects.filter(line => line === "thread/start")).toHaveLength(1);
        expect(effects.filter(line => line === "turn/start")).toHaveLength(0);
      } catch (error) {
        const physical = JSON.parse(await readFile(join(directory, "runner/runner-state.json"), "utf8").catch(() => "{}"));
        throw new Error(`${mode}/${boundary}: ${String(error)}; ${JSON.stringify({
          active: currentCore?.activeRunnerConnectionCount(), coreRun: currentCore?.store.state.identity.runId,
          coreWarm: currentCore?.store.state.warmTransition?.phase, header: checkpoint && inspectStagedRunAttachmentHeader(checkpoint.records.get("header")!)?.phase,
          runnerRun: physical.runId, runnerWarm: physical.warmTransition?.phase, lifecycle: physical.lifecycle,
          failureCode: physical.recoverableFailure?.code, failureKeys: Object.keys(physical.recoverableFailure ?? {}),
          physicalFailure: physical.recoverableFailure,
        })}`, { cause: error });
      } finally {
        release();
        if (!runnerPid && !replacement) { await first.transport.close().catch(() => undefined); await first.retireProbeResources?.(1_000).catch(() => undefined); }
        else await first.detachControllerForRestart().catch(() => undefined);
        await replacement?.transport.close().catch(() => undefined);
        for (const pid of [providerPid, runnerPid]) if (pid && !dead(-pid)) { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
        for (const core of cores) await core.stop().catch(() => undefined);
        for (const pid of [providerPid, runnerPid]) if (pid) await vi.waitFor(() => expect(dead(pid)).toBe(true));
      }
    }
  } finally { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); await rm(root, { recursive: true, force: true }); }
}, 90_000);
