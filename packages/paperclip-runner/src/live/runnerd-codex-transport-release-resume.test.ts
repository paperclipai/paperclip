import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { DurablePrpControlPlane, RunnerProcessHandle, PrpWireConnection, TransportCloseReason } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport, readRunnerdArtifactBinding } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";
import { createPrivateHostControlFixture } from "../../test/support/private-host-control.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import { createCodexTaskEnvelope } from "../contracts/codex.js";
import type { HarnessSession, PersistedHarnessSession } from "../contracts/harness-driver.js";
import { QUALIFIED_ACPX_PROFILES } from "../drivers/acpx/qualified-profiles.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const parkId = (source: Record<string, unknown>) => `park_${digest(JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b)))))}`;

async function nativeWire(port: number, path: string): Promise<PrpWireConnection> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    } });
    request.on("error", () => reject(new Error("Fixture listener unavailable")));
    request.on("response", response => { response.resume(); reject(new Error("Fixture listener upgrade refused")); });
    request.setTimeout(1_000, () => request.destroy(new Error("Fixture listener timeout")));
    request.on("upgrade", (_response, socket, head) => {
      request.setTimeout(0);
      let buffer = Buffer.alloc(0), handler: ((value: unknown) => void) | undefined;
      const pending: unknown[] = [], closed = new Set<(reason: TransportCloseReason) => void>();
      const send = (opcode: number, payload: Buffer) => {
        const mask = randomBytes(4), bytes = Buffer.from(payload);
        for (let index = 0; index < bytes.length; index++) bytes[index] ^= mask[index % 4]!;
        const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65_536 ? 4 : 10);
        header[0] = 0x80 | opcode;
        if (header.length === 2) header[1] = 0x80 | payload.length;
        else if (header.length === 4) { header[1] = 0xfe; header.writeUInt16BE(payload.length, 2); }
        else { header[1] = 0xff; header.writeBigUInt64BE(BigInt(payload.length), 2); }
        socket.write(Buffer.concat([header, mask, bytes]));
      };
      const consume = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          if ((buffer[0]! & 0x80) === 0 || (buffer[1]! & 0x80) !== 0) { socket.destroy(); return; }
          let length = buffer[1]! & 0x7f, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          else if (length === 127) {
            if (buffer.length < 10) return;
            const size = buffer.readBigUInt64BE(2);
            if (size > 4_194_304n) { socket.destroy(); return; }
            length = Number(size); offset = 10;
          }
          if (buffer.length < offset + length) return;
          const opcode = buffer[0]! & 0x0f, payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 8) { socket.destroy(); return; }
          if (opcode === 9) { send(10, payload); continue; }
          if (opcode !== 1) continue;
          try { const value: unknown = JSON.parse(payload.toString("utf8")); if (handler) handler(value); else pending.push(value); }
          catch { socket.destroy(); return; }
        }
      };
      socket.on("data", consume);
      socket.on("close", () => { for (const close of closed) close({ message: "fixture route closed" }); });
      socket.on("error", () => {});
      resolve({ sendJson: value => send(1, Buffer.from(JSON.stringify(value))), close: () => socket.destroy(),
        onJson: receive => { handler = receive; for (const value of pending.splice(0)) receive(value); },
        onClose: close => { closed.add(close); } });
      consume(head);
    });
    request.end();
  });
}

it.skipIf(process.platform === "win32").each(["cached", "lost claim reply", "cache adoption", "acpx cache adoption", "unavailable", "claim cancellation", "expired ticket", "late claim reply", "held past deadline", "release admission", "no cleanup callback", "adoption no cleanup callback", "resume no cleanup callback", "deferred turn after close"] as const)(
  "releases and resumes the native Codex source before attachment (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "runner-release-resume-"));
    const acpx = mode === "acpx cache adoption";
    const sidecar = join(root, "sidecar"), sidecarScript = join(root, "sidecar-entry");
    if (acpx) {
      const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
      const fake = resolve(import.meta.dirname, "../../runner/target/debug/fake-acpx-sidecar");
      await writeFile(sidecarScript, "qualified fixture entry");
      await writeFile(sidecar, `#!/bin/sh\nexec ${quote(fake)} --mode source-reconcile --profile-digest ${quote(QUALIFIED_ACPX_PROFILES.claude.commandDigest)} --journal ${quote(join(root, "calls"))} --source-fault ${quote(join(root, "fault"))}\n`, { mode: 0o700 });
    }
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
    const port = address.port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const fixture = createPrivateHostControlFixture();
    const identity = { runnerInstanceId: "retained-runner", environmentLeaseId: "retained-lease", runId: "source-run",
      normalizedSessionId: "retained-session", turnId: "source-turn", itemId: "source-item" };
    const binary = defaultCapabilityRunnerdBinary();
    const runnerFile = join(root, "runner/runner-state.json");
    const claimTicketDigests: string[] = [], routeRuns: string[] = [];
    let authority: DurablePrpControlPlane | undefined;
    let claimantRunId = identity.runId;
    let handle: RunnerProcessHandle | undefined;
    let loseReply = mode === "lost claim reply";
    let closeCheckpoint = 0, claimAccepted = false, adopting = false;
    let acceptClaim!: () => void;
    const acceptedClaim = new Promise<void>(resolve => { acceptClaim = resolve; });
    let releaseClaim!: () => void;
    const claimReceipt = new Promise<void>(resolve => { releaseClaim = resolve; });
    let expireClock: ReturnType<typeof vi.spyOn> | undefined;
    let holdMeasuredTurn = false, enterMeasuredTurn!: () => void, finishMeasuredTurn!: () => void;
    const measuredTurn = new Promise<void>(resolve => { enterMeasuredTurn = resolve; });
    const heldMeasuredTurn = new Promise<void>(resolve => { finishMeasuredTurn = resolve; });
    const sockets = new Set<PrpWireConnection>();
    const registration = async (core: DurablePrpControlPlane, source = core.store.state.identity) => {
      if ((mode === "late claim reply" || mode === "held past deadline") && claimAccepted) throw new Error("Fixture source authentication started after expiry");
      authority = core;
      let socket: PrpWireConnection | undefined;
      return {
        connection: { mode: "listen" as const, listenAddress: "0.0.0.0" as const, listenPort: port, listenPath: `/api/runner/v1/connect/${source.runId}` },
        activate: async () => {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            let candidate: PrpWireConnection;
            try { candidate = await nativeWire(port, `/api/runner/v1/connect/${source.runId}`); }
            catch { await new Promise(resolve => setTimeout(resolve, 10)); continue; }
            sockets.add(candidate);
            socket = candidate;
            const attachment = core.attachWireConnection(candidate);
            await vi.waitFor(() => expect(attachment.isAuthenticated()).toBe(true), { timeout: 5_000 });
            routeRuns.push(source.runId);
            return;
          }
          throw new Error("Fixture source authentication timed out");
        },
        checkpoint: mode === "no cleanup callback" || mode === "deferred turn after close" || (mode === "adoption no cleanup callback" && adopting) || (mode === "resume no cleanup callback" && claimAccepted) ? undefined : async (settlement: "settled" | "unsettled") => {
          expect(settlement).toBe("unsettled");
          closeCheckpoint += 1;
          await fixture.close();
        },
        release: async () => { socket?.close(); },
      };
    };
    const pair = {
      release: vi.fn(async (source: typeof identity) => {
        const state = await read(runnerFile);
        const result = await fixture.request({ op: "park", id: parkId(source), identity: source,
          lastControllerCommandSeq: state.lastControllerCommandSeq, ackedSourceSeq: state.ackedSourceSeq });
        if (result.status !== "parked") throw new Error("Fixture park receipt unavailable");
      }),
      resume: vi.fn(async (source: typeof identity, ticket: string): Promise<"resumed" | "unavailable"> => {
        claimTicketDigests.push(digest(ticket));
        if (mode === "unavailable") {
          expect(handle?.isExitConfirmed?.()).toBe(true);
          return "unavailable";
        }
        const result = await fixture.request({ op: "claim", id: `claim_${claimantRunId}`,
          parkId: parkId(source), bootstrapTicket: ticket });
        if (result.status !== "claimed") throw new Error("Fixture claim receipt unavailable");
        claimAccepted = true; acceptClaim();
        if (mode === "claim cancellation" || mode === "held past deadline") await claimReceipt;
        if (mode === "expired ticket" || mode === "late claim reply") {
          expireClock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
          if (mode === "expired ticket") throw new Error("Fixture lost claim reply past ticket lifetime");
        }
        if (loseReply) { loseReply = false; throw new Error("Fixture lost claim reply"); }
        return "resumed";
      }),
    };
    const acpxArguments = acpx ? ["--acpx-launch-authority-digest", `sha256:${digest("fixture authority")}`,
      "--acpx-sidecar-command", sidecar, "--acpx-sidecar-command-sha256", `sha256:${digest(await readFile(sidecar, "utf8"))}`,
      "--acpx-sidecar-script", sidecarScript, "--acpx-sidecar-script-sha256", `sha256:${digest("qualified fixture entry")}`] : [];
    const launch = vi.fn((spec: Parameters<typeof fixture.launch>[0]) => { handle = fixture.launch({ ...spec, args: [...spec.args, ...acpxArguments] }); return handle; });
    const options = { runnerBinary: binary, runnerArtifact: readRunnerdArtifactBinding(binary), stateDirectory: root,
      codexCommand: fakeCodex, codexArgs: fakeCodexArgs(root), prpIdentity: identity,
      get authorityRunId() { return claimantRunId; }, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      runnerProcessLauncher: launch, controlPlaneRegistration: registration, releaseResume: pair,
      ...((mode === "release admission" || mode === "deferred turn after close") ? { measureOperation: async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
        if (phase === "runner.transport.turn_start" && holdMeasuredTurn) { enterMeasuredTurn(); await heldMeasuredTurn; }
        return work();
      } } : {}),
      ...(acpx ? { provider: "acpx" as const, acpxAgent: "claude" as const, acpxRuntimeDirectory: join(root, "acpx"),
        prepareLaunch: async (input: RunnerProviderLaunchRequirements) => ({ configurationId: `fixture-${input.identity.runId}`, requirementsDigest: runnerLaunchRequirementsDigest(input),
          provider: createRunnerProviderLaunch(input, { options: {}, root, cwd: root, codexHome: root, codexCommand: "", providerNodeCommand: sidecar, opencodeProxyPath: "", acpxSidecarPath: sidecarScript }) }) } : {}) };
    const intervals = new Set<unknown>(), originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
    const armInterval = vi.spyOn(globalThis, "setInterval").mockImplementation((...args: Parameters<typeof setInterval>) => {
      const timer = originalInterval(...args);
      if (args[1] === 5 || args[1] === 250) intervals.add(timer);
      return timer;
    });
    const clearInterval = vi.spyOn(globalThis, "clearInterval").mockImplementation((...args: Parameters<typeof globalThis.clearInterval>) => {
      intervals.delete(args[0]); originalClear(...args);
    });
    let bundle = createCapabilityRunnerdCodexTransport(options);
    let recoveredSession: HarnessSession | undefined;
    const complete = async () => {
      if (recoveredSession) {
        await recoveredSession.startTurn({ message: { role: "user", text: "Complete the fixture follow-up" } });
        for await (const event of recoveredSession.events()) if (event.eventType === "turn.completed") return;
        throw new Error("Fixture follow-up terminal unavailable");
      }
      const terminal = (async () => { for await (const event of bundle.transport.notifications()) if (event.method === "turn/completed") return; })();
      await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Complete the fixture turn" }] });
      await terminal;
    };
    try {
      const opened = await bundle.transport.request("thread/start", { cwd: root, dynamicTools: [], ...(acpx ? { model: "explicit-source-model" } : {}) });
      const threadId = String((opened.thread as { id: string }).id);
      await complete();
      if (mode === "deferred turn after close") {
        holdMeasuredTurn = true;
        const starting = bundle.transport.request("turn/start", { input: [{ type: "text", text: "Must not start after close" }] });
        void starting.catch(() => undefined);
        await measuredTurn;
        await bundle.transport.close();
        const commands = authority!.store.state.commands.length;
        expect(handle!.isExitConfirmed?.()).toBe(true);
        finishMeasuredTurn();
        await expect(starting).rejects.toThrow("closed");
        expect(authority!.store.state.commands).toHaveLength(commands);
        return;
      }
      if (mode === "cached") {
        const core = authority!, events = core.store.state.committedEvents, last = events.at(-1)!;
        for (const [eventType, payload] of [["turn.started", {}], ["session.goal.updated", { goal: { status: "active" } }],
          ["session.goal.updated", { goal: { status: "paused" }, workingNow: true }],
          ["session.goal.cleared", { goal: null, workingNow: true }], ["session.goal.snapshot", { goal: null, workingNow: true }]] as const) {
          events.push({ ...last, eventType, envelope: { ...last.envelope, payload: { payload } } });
          try { expect(await bundle.transport.release!()).toBe(false); }
          finally { events.pop(); }
          expect(pair.release).not.toHaveBeenCalled();
          expect(core.activeRunnerConnectionCount()).toBe(1);
        }
        const unsettled = vi.spyOn(core, "semanticToolResultsSettled").mockReturnValue(false);
        try { expect(await bundle.transport.release!()).toBe(false); }
        finally { unsettled.mockRestore(); }
        expect(pair.release).not.toHaveBeenCalled();
        await complete();
      }
      if (mode === "no cleanup callback") {
        const released = await bundle.transport.release!();
        if (released === false) await complete();
        await expect(bundle.transport.close()).resolves.toBeUndefined();
        expect(released).toBe(false);
        expect(pair.release).not.toHaveBeenCalled();
        expect(closeCheckpoint).toBe(0);
        expect(handle!.isExitConfirmed?.()).toBe(true);
        return;
      }
      if (mode === "release admission") {
        holdMeasuredTurn = true;
        const earlierStart = bundle.transport.request("turn/start", { input: [{ type: "text", text: "Deferred measured turn" }] });
        void earlierStart.catch(() => undefined);
        await measuredTurn;
        const core = authority!, originalFlush = core.flushCheckpoint.bind(core);
        let entered!: () => void, finish!: () => void;
        const flushing = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { finish = resolve; });
        const flush = vi.spyOn(core, "flushCheckpoint").mockImplementationOnce(async () => {
          entered(); await held; await originalFlush();
        });
        const releasing = bundle.transport.release!();
        try {
          await flushing;
          const commands = core.store.state.commands.length;
          finishMeasuredTurn();
          await expect(earlierStart).rejects.toThrow("run_attachment_in_progress");
          for (const method of ["thread/read", "thread/resume", "thread/turns/list", "thread/goal/get"]) {
            await expect(bundle.transport.request(method, { threadId })).rejects.toThrow("run_attachment_in_progress");
          }
          await expect(bundle.transport.request("initialize", {})).resolves.toEqual({ user: {} });
          await expect(bundle.transport.request("turn/start", { input: [{ type: "text", text: "Must stay fenced" }] }))
            .rejects.toThrow("run_attachment_in_progress");
          await expect(bundle.transport.request("thread/goal/set", { threadId, objective: "Must stay fenced" }))
            .rejects.toThrow("run_attachment_in_progress");
          expect(core.store.state.commands).toHaveLength(commands);
        } finally { finishMeasuredTurn(); finish(); flush.mockRestore(); await Promise.allSettled([earlierStart, releasing]); }
      }
      await vi.waitFor(async () => expect(await bundle.transport.release!()).toEqual(identity), { timeout: 5_000 });
      if (mode === "cached") {
        const source = await bundle.transport.release!();
        expect(source).toEqual(identity);
        if (source !== false) source.runId = "changed-return-value";
        expect(await bundle.transport.release!()).toEqual(identity);
        expect(pair.release).toHaveBeenCalledOnce();
      }
      await vi.waitFor(() => expect(authority?.activeRunnerConnectionCount()).toBe(0));
      expect(intervals.size).toBe(0);
      expect(launch).toHaveBeenCalledOnce();
      await expect(bundle.transport.request("turn/start", { input: [] })).rejects.toThrow("release_resume_pending");
      await expect(bundle.transport.request("thread/resume", { threadId })).rejects.toThrow("release_resume_pending");
      claimantRunId = "claimant-run";
      if (mode === "cache adoption" || mode === "acpx cache adoption" || mode === "adoption no cleanup callback") {
        await bundle.transport.detachControllerForRestart!();
        adopting = true;
        bundle = createCapabilityRunnerdCodexTransport({ ...options, get authorityRunId() { return claimantRunId; },
          releaseResume: { ...pair, releasedSource: identity },
          adoptExistingRunner: { pid: handle!.child.pid ?? null, processGroupId: handle!.processGroupId ?? null,
            startedAt: handle!.startedAt ?? null, isAlive: () => handle!.isExitConfirmed?.() === false,
            signal: () => { handle!.child.kill("SIGKILL"); return true; } },
          resumeProviderSession: { driverSessionId: threadId, providerSessionId: threadId },
        });
        const request = vi.spyOn(bundle.transport, "request");
        const driver = new CodexAppServerDriver({ conversationMode: "direct",
          taskEnvelope: createCodexTaskEnvelope({ objective: "Complete the fixture turn", contractRevision: "fixture", criteria: [] }),
          transportFactory: () => bundle.transport, workingDirectoryAuthority: "remote_runner", environment: { PAPERCLIP_WORKSPACE_CWD: root },
          ...(acpx ? { capabilities: { goals: false, threadLineage: false }, driverIdentity: { kind: "acpx_runtime", displayName: "Claude via ACPX", version: "fixture" } } : {}) });
        const original = opened.thread as { sessionId: string; providerIdentity?: PersistedHarnessSession["providerIdentity"] };
        const recovered = await driver.recoverSession({ driverKind: acpx ? "acpx_runtime" : "codex_app_server",
          driverSessionId: threadId, providerSessionId: original.sessionId, providerIdentity: original.providerIdentity,
          runId: identity.runId, normalizedSessionId: identity.normalizedSessionId });
        if (mode === "adoption no cleanup callback") {
          expect(recovered.recovered).toBe(false);
          expect(recovered.reason).toContain("released_cleanup_unavailable");
          expect(pair.resume).not.toHaveBeenCalled();
          await bundle.transport.close();
          expect(closeCheckpoint).toBe(0);
          expect(handle!.isExitConfirmed?.()).toBe(false);
          return;
        }
        expect(recovered.recovered, recovered.reason).toBe(true);
        recoveredSession = recovered.session;
        expect(request.mock.calls.map(([method]) => method)).toEqual(expect.arrayContaining(["thread/read", "thread/turns/list", "thread/resume"]));
        expect((await recoveredSession!.snapshot()).driverSessionId).toBe(threadId);
        await expect(bundle.transport.request("thread/resume", { threadId: "foreign-thread" })).rejects.toThrow("history_identity_mismatch");
        await expect(bundle.transport.request("turn/start", { input: [] })).rejects.toThrow("release_resume_pending");
        await expect(bundle.transport.request("thread/goal/set", { threadId, objective: "Must stay fenced" })).rejects.toThrow("release_resume_pending");
      }
      if (mode === "unavailable") await fixture.close();
      if (mode === "held past deadline") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const attaching = Promise.resolve(recoveredSession
        ? recoveredSession.attachRun!({ runId: claimantRunId })
        : bundle.transport.attachRun!({ runId: claimantRunId, turnId: "next-turn", itemId: "next-item" }));
      void attaching.catch(() => undefined);
      if (mode === "held past deadline") {
        await acceptedClaim;
        let failure: unknown;
        const settled = attaching.catch(error => { failure = error; });
        await vi.advanceTimersByTimeAsync(61_000);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("reconciliation_expired");
        vi.useRealTimers();
        await settled;
        await bundle.transport.close();
        releaseClaim();
        await Promise.resolve();
        expect(routeRuns).toEqual([identity.runId]);
      } else if (mode === "claim cancellation") {
        await vi.waitFor(() => expect(claimAccepted).toBe(true));
        const closing = bundle.transport.close();
        expect(closeCheckpoint).toBe(0);
        releaseClaim();
        await expect(attaching).rejects.toThrow("closed");
        await closing;
      } else if (mode === "unavailable" || mode === "expired ticket" || mode === "late claim reply" || mode === "resume no cleanup callback") {
        await expect(attaching).rejects.toThrow(mode === "unavailable" ? "reuse_unavailable" : mode === "resume no cleanup callback" ? "released_cleanup_unavailable" : "reconciliation_expired");
        expireClock?.mockRestore(); expireClock = undefined;
        await bundle.transport.close();
      } else await attaching;
      expect(new Set(claimTicketDigests).size).toBe(1);
      if (["unavailable", "claim cancellation", "expired ticket", "late claim reply", "held past deadline", "resume no cleanup callback"].includes(mode)) {
        expect(pair.resume).toHaveBeenCalledOnce();
        expect(authority!.store.state.identity.runId).toBe(identity.runId);
        expect(launch).toHaveBeenCalledOnce();
        expect(closeCheckpoint).toBe(1);
        expect(handle!.isExitConfirmed?.()).toBe(true);
        expect(intervals.size).toBe(0);
        return;
      }
      expect(pair.resume).toHaveBeenCalledTimes(mode === "lost claim reply" ? 2 : 1);
      expect(routeRuns).toContain(identity.runId);
      expect((await read(runnerFile)).runId).toBe(claimantRunId);
      expect(launch).toHaveBeenCalledOnce();
      await complete();
      const nextSource = structuredClone(authority!.store.state.identity);
      await vi.waitFor(async () => expect(await bundle.transport.release!()).toEqual(nextSource), { timeout: 5_000 });
      expect(intervals.size).toBe(0);
      await bundle.transport.close();
      expect(closeCheckpoint).toBe(1);
      expect(handle!.isExitConfirmed?.()).toBe(true);
    } finally {
      if (mode === "held past deadline") vi.useRealTimers();
      expireClock?.mockRestore(); releaseClaim(); finishMeasuredTurn();
      try {
        for (const socket of sockets) socket.close();
        await fixture.close();
        await bundle.transport.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      } finally {
        for (const timer of intervals) originalClear(timer as ReturnType<typeof setInterval>);
        armInterval.mockRestore(); clearInterval.mockRestore();
      }
    }
  }, 30_000);
