import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { providerSessionIdentityFromDurableProviderState } from "./native-session-executor.js";
import {
  SETTLED_ACPX_RECOVERY_SCRIPT,
  settledAcpxRecoveryRequest,
} from "./settled-remote-acpx-recovery.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "settled-acpx-")));
  roots.push(root);
  const identity = {
    runId: "prior",
    normalizedSessionId: "session",
    runnerInstanceId: "runner",
    environmentLeaseId: "workspace",
    turnId: "turn",
    itemId: "item",
  };
  const providerIdentity = {
    kind: "acpx",
    normalizedSessionId: "session",
    acpxRecordId: "record",
    backendSessionId: "thread",
    agentSessionId: "thread",
    profileDigest: "sha256:" + "a".repeat(64),
    workspaceDigest: "sha256:" + "b".repeat(64),
    requestedModel: "model",
    effectiveModel: "model",
    permissionMode: "approve-all",
    providerLifetimeFenceCandidates: [55001, 55002, 55003],
  };
  const commands = [
    {
      commandId: "one",
      controllerSeq: 1,
      type: "turn.start",
      status: "completed",
    },
    {
      commandId: "two",
      controllerSeq: 2,
      type: "runner.drain",
      status: "pending",
    },
    {
      commandId: "three",
      controllerSeq: 3,
      type: "runner.suspend",
      status: "pending",
    },
  ];
  const control = {
    schema: "paperclip.runner.durable.control-plane-state.v1",
    identity,
    commands,
    commandDeliveryCounts: { one: 1 },
    ackedSourceSeq: 7,
    committedEvents: [
      { eventType: "run.terminal", sourceSeq: 7, envelope: identity },
    ],
  };
  const runner = {
    schema: "paperclip.runner.durable.state.v1",
    ...identity,
    lifecycle: "ready",
    nextSourceSeq: 8,
    ackedSourceSeq: 7,
    lastControllerCommandSeq: 1,
    compactedThroughControllerSeq: 0,
    outbox: [],
    pendingTerminalDelivery: null,
    processedCommands: {
      one: {
        commandId: "one",
        controllerSeq: 1,
        commandType: "turn.start",
        status: "completed",
      },
    },
  };
  const provider = {
    schema: "paperclip.runner.acpx-provider-state.v3",
    identity: providerIdentity,
    descriptor: {
      kind: "acpx",
      provider: "acpx",
      driver: "acpx_runtime",
      agent: "claude",
      model: "model",
      normalizedSessionId: "session",
      runId: "prior",
      commandDigest: providerIdentity.profileDigest,
      permissionMode: "approve-all",
    },
    lifecycle: "session_open",
    activeTurnId: null,
    providerExitUnconfirmed: false,
    pendingEvents: [],
    privateOutput: "never return conversation",
  };
  const write = () => {
    fs.writeFileSync(join(root, "runner-state.json"), JSON.stringify(runner));
    fs.writeFileSync(
      join(root, "acpx-provider-state.json"),
      JSON.stringify(provider),
    );
    fs.writeFileSync(
      join(root, "runner-process.identity"),
      "ec0e1ae3-0614-44fc-a352-bb03d89134d7\n4321\n2026-09-14T18:00:00.000Z\nrunner\n",
    );
  };
  write();
  const kill = vi.fn(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  const occupied = new Set<number>();
  const fileSystem = { ...fs };
  const closed: number[] = [];
  const net = {
    createServer: () => {
      let reject: (error: Error) => void, port: number;
      return {
        once: (_: string, callback: typeof reject) => {
          reject = callback;
        },
        listen: (options: { port: number }, done: () => void) => {
          port = options.port;
          if (occupied.has(port))
            reject(Object.assign(new Error("busy"), { code: "EADDRINUSE" }));
          else done();
        },
        close: () => {
          closed.push(port);
        },
      };
    },
  };
  const request = () =>
    settledAcpxRecoveryRequest({
      control,
      identity,
      providerIdentity,
      agent: "claude",
      model: "model",
      permissionMode: "approve-all",
      stateDirectory: root,
    });
  const invoke = async (override = {}) => {
    let stdout = "";
    await runInNewContext(
      SETTLED_ACPX_RECOVERY_SCRIPT,
      {
        require: (name: string) =>
          name === "node:net"
            ? net
            : name === "node:fs"
              ? fileSystem
              : require(name),
        Buffer,
        process: {
          argv: ["node", JSON.stringify({ ...request(), ...override })],
          kill,
        },
        console: {
          log: (value: string) => {
            stdout += value;
          },
        },
      },
      { timeout: 1000 },
    );
    return JSON.parse(stdout);
  };
  return {
    root,
    runner,
    provider,
    control,
    request,
    invoke,
    kill,
    occupied,
    fileSystem,
    closed,
    write,
  };
}

describe("settled remote ACPX recovery", () => {
  it.each(["ready", "suspended"])("seals both lifecycle records from runner %s and admits the provider to normal harness validation", async (lifecycle) => {
    const f = fixture(),
      before = fs.readFileSync(join(f.root, "acpx-provider-state.json"));
    f.runner.lifecycle = lifecycle;
    f.write();
    const proof = await f.invoke();
    expect(JSON.stringify(proof)).not.toContain("never return conversation");
    expect(
      JSON.parse(fs.readFileSync(join(f.root, "runner-state.json"), "utf8"))
        .lifecycle,
    ).toBe(lifecycle);
    expect(fs.readFileSync(join(f.root, "acpx-provider-state.json"))).toEqual(before);
    await f.invoke({ seal: proof });
    expect(
      JSON.parse(fs.readFileSync(join(f.root, "runner-state.json"), "utf8"))
        .lifecycle,
    ).toBe("suspended");
    const provider = JSON.parse(
      fs.readFileSync(join(f.root, "acpx-provider-state.json"), "utf8"),
    );
    expect(provider).toEqual({ ...f.provider, lifecycle: "suspended" });
    const execution = {
      binding: { runId: "next" },
      session: { normalizedSessionId: "session" },
      provider: {
        kind: "acpx",
        agent: "claude",
        model: "model",
        permissionMode: "approve-all",
      },
    } as Parameters<typeof providerSessionIdentityFromDurableProviderState>[0]["execution"];
    expect(
      providerSessionIdentityFromDurableProviderState({
        execution,
        providerState: provider,
      }),
    ).toEqual({
      providerSessionId: "record",
      providerBackendSessionId: "thread",
      providerSessionIdentity: f.provider.identity,
    });
    expect(f.control.commands[1]!.status).toBe("pending");
    expect(f.closed.length).toBe(4);
  });
  it.each([1, 2])("recovers an interrupted seal before atomic rename %s using fresh evidence", async (failAt) => {
    const f = fixture(),
      proof = await f.invoke();
    let renames = 0;
    const rename = vi.spyOn(f.fileSystem, "renameSync").mockImplementation((from, to) => {
      if (++renames === failAt) throw new Error("interrupted seal");
      fs.renameSync(from, to);
    });
    await expect(f.invoke({ seal: proof })).rejects.toThrow("interrupted seal");
    rename.mockRestore();
    const provider = JSON.parse(
      fs.readFileSync(join(f.root, "acpx-provider-state.json"), "utf8"),
    );
    expect(provider).toEqual({ ...f.provider, lifecycle: failAt === 1 ? "session_open" : "suspended" });
    expect(JSON.parse(fs.readFileSync(join(f.root, "runner-state.json"), "utf8"))).toEqual(f.runner);
    if (failAt === 2) await expect(f.invoke({ seal: proof })).rejects.toThrow();
    const fresh = await f.invoke();
    await f.invoke({ seal: fresh });
    expect(JSON.parse(fs.readFileSync(join(f.root, "runner-state.json"), "utf8")).lifecycle).toBe("suspended");
    expect(JSON.parse(fs.readFileSync(join(f.root, "acpx-provider-state.json"), "utf8"))).toEqual({ ...f.provider, lifecycle: "suspended" });
    expect(fs.readdirSync(f.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it.each([
    "pending turn",
    "delivered shutdown",
    "wrong terminal",
    "wrong authority",
    "sequence gap",
  ])("rejects ambiguous host evidence: %s", async (kind) => {
    const f = fixture();
    if (kind === "pending turn") f.control.commands[1]!.type = "turn.start";
    if (kind === "delivered shutdown")
      Object.assign(f.control.commandDeliveryCounts, { two: 1 });
    if (kind === "wrong terminal")
      f.control.committedEvents[0]!.eventType = "turn.completed";
    if (kind === "wrong authority")
      f.control.committedEvents[0]!.envelope = {
        ...f.control.identity,
        runId: "other",
      };
    if (kind === "sequence gap") f.control.commands[1]!.controllerSeq = 4;
    expect(() => f.request()).toThrow();
  });
  it.each([
    "active turn",
    "pending events",
    "exit unconfirmed",
    "wrong provider",
    "unacknowledged event",
    "pending terminal",
    "unknown command",
    "live runner",
    "permission denied",
    "live provider",
    "changed state",
    "symlink",
  ])("leaves state untouched when recovery is unsafe: %s", async (kind) => {
    const f = fixture(),
      proof = await f.invoke();
    if (kind === "active turn")
      Object.assign(f.provider, { activeTurnId: "active" });
    if (kind === "pending events")
      Object.assign(f.provider, { pendingEvents: [{}] });
    if (kind === "exit unconfirmed") f.provider.providerExitUnconfirmed = true;
    if (kind === "wrong provider")
      f.provider.identity.backendSessionId = "other";
    if (kind === "unacknowledged event") f.runner.nextSourceSeq++;
    if (kind === "pending terminal")
      Object.assign(f.runner, { pendingTerminalDelivery: {} });
    if (kind === "unknown command")
      Object.assign(f.runner.processedCommands, { two: { controllerSeq: 2 } });
    if (kind === "live runner") f.kill.mockImplementation(() => true as never);
    if (kind === "permission denied")
      f.kill.mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      });
    if (kind === "live provider") {
      f.occupied.add(55001);
      f.occupied.add(55002);
    }
    if (kind === "changed state")
      Object.assign(f.runner, { reconnectCount: 1 });
    f.write();
    if (kind === "symlink") {
      fs.renameSync(
        join(f.root, "runner-state.json"),
        join(f.root, "elsewhere"),
      );
      fs.symlinkSync(
        join(f.root, "elsewhere"),
        join(f.root, "runner-state.json"),
      );
    }
    const before = fs.readFileSync(join(f.root, "runner-state.json"));
    const providerBefore = fs.readFileSync(join(f.root, "acpx-provider-state.json"));
    await expect(f.invoke({ seal: proof })).rejects.toThrow();
    expect(fs.readFileSync(join(f.root, "runner-state.json"))).toEqual(before);
    expect(fs.readFileSync(join(f.root, "acpx-provider-state.json"))).toEqual(providerBefore);
  });
});
