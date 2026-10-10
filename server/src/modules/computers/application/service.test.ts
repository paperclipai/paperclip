import { describe, it, expect, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { remoteProgram } from "../adapters/remote-program.js";
import { createComputerService } from "./service.js";
import type { ComputerBackend, ComputerRepository } from "./ports.js";
import { ComputerError, type ComputerRecord } from "../domain/ledger.js";

function fixture() {
  let record: ComputerRecord | undefined;
  let clock = new Date("2026-10-10T12:00:00Z");
  let state = "ready";
  let stopStatus = "pending";
  const repository: ComputerRepository = {
    create: async (value) => {
      record = structuredClone(value);
    },
    get: async (scope) => {
      if (
        !record ||
        record.companyId !== scope.companyId ||
        record.environmentId !== scope.environmentId
      )
        throw new ComputerError("not_found", "missing");
      return structuredClone(record);
    },
    update: async (scope, fn) => {
      const next = await repository.get(scope);
      const result = fn(next);
      record = next;
      return result;
    },
    all: async () => (record ? [structuredClone(record)] : []),
    runState: vi.fn(async () => "active" as const),
  };
  const backend: ComputerBackend = {
    inspect: vi.fn(async () => ({ state, snapshots: true, stop: null })),
    ready: vi.fn(async () => {
      state = "ready";
    }),
    claim: vi.fn(async () => {}),
    advance: vi.fn(async () => {}),
    runner: vi.fn(async () => ({ execute: vi.fn() })),
    launch: vi.fn(async (_record, owner) => ({
      ...owner.process!,
      bootId: "boot",
    })),
    inspectProcess: vi.fn(async (_record, owner) => ({
      running: true,
      claim: owner.process,
    })),
    retire: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ id: "stop_1", status: stopStatus })),
    stopStatus: vi.fn(async () => ({ id: "stop_1", status: stopStatus })),
    renew: vi.fn(async () => {}),
    computerTool: () => ({ command: "cua-driver", args: ["mcp"] }),
    desktop: vi.fn(async () => ({
      viewerUrl: "https://test.on.boat.dev/#credential",
      expiresAt: new Date(clock.getTime() + 540_000).toISOString(),
    })),
    ingress: vi.fn(async () => ({
      url: "wss://test.on.boat.dev/",
      secretHeaders: { Cookie: "private" },
    })),
    preview: vi.fn(async () => ({
      url: "https://test.on.boat.dev/?_token=private",
    })),
    remote: vi.fn(async () => ({
      remoteCwd: "/home/user/paperclip/company/projects/project/checkout",
    })),
  };
  const service = createComputerService(repository, backend, () => clock, {
    admissionWaitMs: 0,
  });
  const scope = { companyId: "company", environmentId: "environment" };
  const attach = () =>
    service.attach({
      ...scope,
      sandboxId: "bx_fixture",
      apiKeySecretRef: { type: "secret_ref", secretId: "secret" },
    });
  const admit = (agentId = "agent", sessionKey = "session") =>
    service.admit({
      ...scope,
      agentId,
      sessionKey,
      runId: "run",
      idleTimeoutMs: 60_000,
    });
  return {
    service,
    backend,
    scope,
    attach,
    admit,
    repository,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    completeStop: () => {
      stopStatus = "completed";
      state = "stopped";
    },
  };
}
describe("computer ownership", () => {
  it("passes checkout credentials transiently without retaining them in computer state", async () => {
    const f = fixture();
    await f.attach();
    const binding = await f.admit();
    const gitAuth = { configArgs: ["-c", "credential.helper="], env: { PAPERCLIP_GIT_TOKEN: "scoped-fixture-token" } };
    await f.service.realizeWorkspace({ ...f.scope, owner: binding.owner, projectId: "project", mode: "shared",
      repositoryUrl: "https://github.com/company/private.git", gitAuth });
    expect(f.backend.remote).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "workspace", gitAuth }));
    expect(JSON.stringify(await f.repository.get(f.scope))).not.toContain("scoped-fixture-token");
  });
  it("explains an unavailable dev server without masking provider errors", async () => {
    const f = fixture();
    await f.attach();
    const binding = await f.admit();
    const input = { ...f.scope, owner: binding.owner, port: 5173 };
    vi.mocked(f.backend.remote).mockRejectedValueOnce(new ComputerError("conflict", "Computer operation: conflict"));
    await expect(f.service.preview(input)).rejects.toMatchObject({
      code: "conflict", message: "No dev server is running on this port for this task. Start it in the task and try again.",
    });
    const offline = new ComputerError("provider_error", "Provider unavailable");
    vi.mocked(f.backend.remote).mockRejectedValueOnce(offline);
    await expect(f.service.preview(input)).rejects.toBe(offline);
    expect(f.backend.preview).not.toHaveBeenCalled();
  });
  it("reuses warm process identity and port while fencing stale callbacks", async () => {
    const f = fixture();
    await f.attach();
    const first = await f.admit();
    const claim = await first.launch({ command: "runnerd" });
    await f.service.retainWarm({
      ...f.scope,
      owner: first.owner,
      idleTimeoutMs: 60_000,
    });
    const next = await f.admit();
    expect(next.owner.generation).toBe(first.owner.generation + 1);
    expect(next.listenerPort).toBe(first.listenerPort);
    expect((await next.inspectProcess()).claim?.nonce).toBe(claim.nonce);
    await f.service.retire({ ...f.scope, owner: first.owner });
    expect(f.backend.retire).not.toHaveBeenCalled();
    await f.service.retire({ ...f.scope, owner: next.owner });
    expect(f.backend.retire).toHaveBeenCalledOnce();
  });
  it("does not suspend another agent and fences admission until provider stop completes", async () => {
    const f = fixture();
    await f.attach();
    const a = await f.admit("agent-a", "a");
    const b = await f.admit("agent-b", "b");
    expect(a.listenerPort).not.toBe(b.listenerPort);
    expect(a.agentHome).not.toBe(b.agentHome);
    await f.service.retire({ ...f.scope, owner: a.owner });
    await f.service.reconcile();
    expect(f.backend.stop).not.toHaveBeenCalled();
    await f.service.retire({ ...f.scope, owner: b.owner });
    await f.service.reconcile();
    expect(f.backend.stop).toHaveBeenCalledOnce();
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
    await f.service.reconcile();
    expect(f.backend.stopStatus).toHaveBeenCalledOnce();
    f.completeStop();
    await f.service.reconcile();
    await expect(f.admit()).resolves.toHaveProperty("owner");
  });
  it("retains a failed stop intent and retries the same idempotent operation", async () => {
    const f = fixture();
    await f.attach();
    vi.mocked(f.backend.stop).mockRejectedValueOnce(
      new Error("network response lost"),
    );
    await expect(f.service.reconcile()).rejects.toBeInstanceOf(AggregateError);
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
    await f.service.reconcile();
    expect(f.backend.stop).toHaveBeenCalledTimes(2);
    expect(
      (await f.repository.get(f.scope)).ledger.action?.providerStopId,
    ).toBe("stop_1");
  });
  it("replaces a superseded stop while preserving the admission fence", async () => {
    const f = fixture();
    await f.attach();
    await f.service.reconcile();
    vi.mocked(f.backend.stopStatus).mockResolvedValueOnce({ id: "stop_1", status: "superseded" });
    vi.mocked(f.backend.stop).mockResolvedValueOnce({ id: "stop_2", status: "pending" });
    await f.service.reconcile();
    expect((await f.repository.get(f.scope)).ledger.action?.providerStopId).toBe("stop_2");
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
    vi.mocked(f.backend.stopStatus).mockResolvedValueOnce({ id: "stop_2", status: "completed" });
    await f.service.reconcile();
    expect(f.backend.stopStatus).toHaveBeenLastCalledWith(expect.anything(), "stop_2");
    await expect(f.admit()).resolves.toHaveProperty("owner");
  });
  it("adopts a newer pending stop without issuing a duplicate operation", async () => {
    const f = fixture();
    await f.attach();
    await f.service.reconcile();
    vi.mocked(f.backend.stopStatus).mockResolvedValueOnce({ id: "stop_1", status: "superseded" });
    vi.mocked(f.backend.inspect).mockResolvedValueOnce({ state: "ready", snapshots: true, stop: { id: "stop_2", status: "failing" } });
    await f.service.reconcile();
    expect((await f.repository.get(f.scope)).ledger.action?.providerStopId).toBe("stop_2");
    expect(f.backend.stop).toHaveBeenCalledOnce();
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
  });
  it("settles a superseded stop only after physical archival proof", async () => {
    const f = fixture();
    await f.attach();
    await f.service.detach(f.scope);
    vi.mocked(f.backend.stopStatus).mockResolvedValueOnce({ id: "stop_1", status: "superseded" });
    vi.mocked(f.backend.inspect).mockResolvedValueOnce({ state: "archived", snapshots: true, stop: null });
    await f.service.reconcile();
    expect((await f.repository.get(f.scope)).ledger).toMatchObject({ status: "detached", action: null });
    expect(f.backend.stop).toHaveBeenCalledOnce();
  });
  it("viewer renewals cannot extend the absolute warm deadline or use another user", async () => {
    const f = fixture();
    await f.attach();
    const viewer = await f.service.connect({
      ...f.scope,
      userId: "alice",
      idleTimeoutMs: 10_000,
    });
    expect(viewer.expiresAt).toBe("2026-10-10T12:00:10.000Z");
    await expect(
      f.service.renewViewer({ ...f.scope, owner: viewer.owner, userId: "bob" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    f.advance(9_000);
    expect(
      (
        await f.service.renewViewer({
          ...f.scope,
          owner: viewer.owner,
          userId: "alice",
        })
      ).expiresAt,
    ).toBe(viewer.expiresAt);
    f.advance(1_001);
    await expect(
      f.service.renewViewer({
        ...f.scope,
        owner: viewer.owner,
        userId: "alice",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.service.reconcile();
    expect(f.backend.stop).toHaveBeenCalledOnce();
  });
  it("a failed exact-process retirement keeps the machine held", async () => {
    const f = fixture();
    await f.attach();
    const a = await f.admit();
    vi.mocked(f.backend.retire).mockRejectedValue(new Error("not confirmed"));
    await expect(
      f.service.retire({ ...f.scope, owner: a.owner }),
    ).rejects.toThrow("not confirmed");
    await expect(f.service.reconcile()).rejects.toBeInstanceOf(AggregateError);
    expect(f.backend.stop).not.toHaveBeenCalled();
  });
  it("keeps snapshot and attachment proof when detached", async () => {
    const f = fixture();
    await f.attach();
    await f.admit();
    await f.service.detach(f.scope);
    expect((await f.repository.get(f.scope)).ledger.status).toBe("detaching");
    f.completeStop();
    await f.service.reconcile();
    expect((await f.repository.get(f.scope)).ledger.status).toBe("detached");
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
  });
  it("rejects cross company scopes before provider access", async () => {
    const f = fixture();
    await f.attach();
    vi.mocked(f.backend.inspect).mockClear();
    await expect(
      f.service.inspect({ ...f.scope, companyId: "another" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.backend.inspect).not.toHaveBeenCalled();
  });
  it("keeps process capabilities across attempt generations only for the exact same process", async () => {
    const f = fixture();
    await f.attach();
    const first = await f.admit();
    await first.launch({ command: "runnerd" });
    await f.service.retainWarm({
      ...f.scope,
      owner: first.owner,
      idleTimeoutMs: 60_000,
    });
    await f.admit();
    await expect(first.ingress()).rejects.toMatchObject({ code: "conflict" });
    await expect(first.process.ingress()).resolves.toHaveProperty("url");
    await f.repository.update(f.scope, (record) => {
      record.ledger.owners[0]!.process!.nonce = "replacement-process";
    });
    await expect(first.process.ingress()).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it.each(["terminal", "missing"] as const)(
    "retires an orphan active owner with a %s run after admission grace",
    async (state) => {
      const f = fixture();
      await f.attach();
      await f.admit();
      vi.mocked(f.repository.runState).mockResolvedValue(state);
      f.advance(119_000);
      await f.service.reconcile();
      expect(f.backend.retire).not.toHaveBeenCalled();
      f.advance(1_001);
      await f.service.reconcile();
      expect(f.backend.retire).toHaveBeenCalledOnce();
      expect(f.backend.stop).toHaveBeenCalledOnce();
    },
  );
  it("fences warm work at its deadline and bounds crashed-controller shutdown grace", async () => {
    const f = fixture();
    await f.attach();
    const binding = await f.admit();
    await binding.launch({ command: "runner" });
    f.advance(180_000);
    await f.service.reconcile();
    expect(f.backend.retire).not.toHaveBeenCalled();
    await f.service.retainWarm({
      ...f.scope,
      owner: binding.owner,
      idleTimeoutMs: 60_000,
    });
    vi.mocked(f.repository.runState).mockResolvedValue("terminal");
    await f.service.reconcile();
    expect(f.backend.retire).not.toHaveBeenCalled();
    f.advance(60_001);
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
    await expect(binding.runner.execute({ command: "new work" })).rejects.toMatchObject({ code: "conflict" });
    await binding.process.runner.execute({ command: "close provider" });
    await f.service.reconcile();
    expect(f.backend.retire).not.toHaveBeenCalled();
    f.advance(30_000);
    await expect(binding.process.ingress()).rejects.toMatchObject({ code: "conflict" });
    await f.service.reconcile();
    expect(f.backend.retire).toHaveBeenCalledOnce();
  });
  it("coalesces concurrent reconciliation before provider stop dispatch", async () => {
    const f = fixture();
    await f.attach();
    let complete!: (value: { id: string; status: string }) => void;
    vi.mocked(f.backend.stop).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const first = f.service.reconcile();
    await vi.waitFor(() => expect(f.backend.stop).toHaveBeenCalledOnce());
    const second = f.service.reconcile();
    await Promise.resolve();
    expect(f.backend.stop).toHaveBeenCalledOnce();
    complete({ id: "stop_1", status: "pending" });
    await Promise.all([first, second]);
    expect(f.backend.stop).toHaveBeenCalledOnce();
  });
  it.each(["retire", "warm"] as const)("waits for terminal predecessor %s before admitting its follow-up", async (transition) => {
    const f = fixture();
    await f.attach();
    const first = await f.admit();
    const claim = await first.launch({ command: "runnerd" });
    vi.mocked(f.repository.runState).mockResolvedValue("terminal");
    const wait = vi.fn(async () => {
      const incumbent = (await f.repository.get(f.scope)).ledger.owners.find(owner => owner.id === first.owner.ownerId)!;
      expect(incumbent.phase).toBe("active");
      expect(incumbent.generation).toBe(first.owner.generation);
      expect(f.backend.retire).not.toHaveBeenCalled();
      if (transition === "retire") await f.service.retire({ ...f.scope, owner: first.owner });
      else await f.service.retainWarm({ ...f.scope, owner: first.owner, idleTimeoutMs: 60_000 });
    });
    const waiting = createComputerService(f.repository, f.backend, () => new Date("2026-10-10T12:00:00Z"), { admissionWaitMs: 2000, wait });
    const next = await waiting.admit({ ...f.scope, agentId: "agent", runId: "follow-up", sessionKey: "session", idleTimeoutMs: 60_000 });
    expect(wait).toHaveBeenCalledOnce();
    expect(f.repository.runState).toHaveBeenCalledWith(expect.objectContaining(f.scope), "run", "agent");
    if (transition === "warm") {
      expect(next.owner.ownerId).toBe(first.owner.ownerId);
      expect(next.owner.generation).toBe(first.owner.generation + 1);
      expect((await next.inspectProcess()).claim?.nonce).toBe(claim.nonce);
      expect(f.backend.retire).not.toHaveBeenCalled();
    } else {
      expect(next.owner.ownerId).not.toBe(first.owner.ownerId);
      expect(f.backend.retire).toHaveBeenCalledOnce();
    }
  });

  it.each(["active", "missing"] as const)("does not wait on or supersede a %s predecessor", async (state) => {
    const f = fixture();
    await f.attach();
    const first = await f.admit();
    vi.mocked(f.repository.runState).mockResolvedValue(state);
    const wait = vi.fn(async () => {});
    const waiting = createComputerService(f.repository, f.backend, () => new Date("2026-10-10T12:00:00Z"), { admissionWaitMs: 2000, wait });
    await expect(waiting.admit({ ...f.scope, agentId: "agent", runId: "follow-up", sessionKey: "session", idleTimeoutMs: 60_000 }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(wait).not.toHaveBeenCalled();
    expect(f.backend.retire).not.toHaveBeenCalled();
    expect((await f.repository.get(f.scope)).ledger.owners[0]?.generation).toBe(first.owner.generation);
  });

  it("bounds the wait for terminal predecessor teardown without forcing retirement", async () => {
    const f = fixture();
    await f.attach();
    await f.admit();
    vi.mocked(f.repository.runState).mockResolvedValue("terminal");
    const wait = vi.fn(async () => {});
    const waiting = createComputerService(f.repository, f.backend, () => new Date("2026-10-10T12:00:00Z"), { admissionWaitMs: 2000, wait });
    await expect(waiting.admit({ ...f.scope, agentId: "agent", runId: "follow-up", sessionKey: "session", idleTimeoutMs: 60_000 }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(f.backend.retire).not.toHaveBeenCalled();
  });

  it("waits for a normal provider snapshot stop before admitting the next turn", async () => {
    const f = fixture();
    await f.attach();
    await f.service.reconcile();
    const waiting = createComputerService(
      f.repository,
      f.backend,
      () => new Date("2026-10-10T12:00:00Z"),
      {
        admissionWaitMs: 2000,
        wait: async () => {
          f.completeStop();
        },
      },
    );
    await expect(
      waiting.admit({
        ...f.scope,
        agentId: "agent",
        runId: "run",
        sessionKey: "session",
        idleTimeoutMs: 60_000,
      }),
    ).resolves.toHaveProperty("owner");
    expect(f.backend.stop).toHaveBeenCalledOnce();
  });
  it("keeps a short bounded file batch hold between editor operations", async () => {
    const f = fixture();
    await f.attach();
    const files = await f.service.files({ ...f.scope, agentId: "agent" });
    await files.seed({});
    await f.service.reconcile();
    expect(f.backend.stop).not.toHaveBeenCalled();
    f.advance(5001);
    await f.service.reconcile();
    expect(f.backend.stop).toHaveBeenCalledOnce();
  });
  it("returns foreground output without waiting for detached command descendants", async () => {
    const f = fixture();
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "computer-command-")));
    let backgroundPid: number | undefined;
    const runPath = join(temp, "systemd-run");
    // The shim starts the real supervisor. Live Boat coverage additionally
    // verifies systemd keeps the descendant in the owner slice and retires it.
    writeFileSync(
      runPath,
      `#!/usr/bin/env python3
import sys,subprocess,json
args=sys.argv[1:]
assert '--property=ExitType=cgroup' in args
assert '--property=KillMode=control-group' in args
assert '--wait' not in args
output=next(v.split('append:',1)[1] for v in args if v.startswith('--property=StandardOutput='))
error=next(v.split('append:',1)[1] for v in args if v.startswith('--property=StandardError='))
cwd=next(v.split('=',1)[1] for v in args if v.startswith('--working-directory='))
with open(output,'wb') as out,open(error,'wb') as err:
 subprocess.Popen(args[args.index('--')+1:],stdout=out,stderr=err,cwd=cwd,start_new_session=True)
`,
      { mode: 0o700 },
    );
    writeFileSync(join(temp, "systemctl"), "#!/bin/sh\necho active\n", {
      mode: 0o700,
    });
    vi.mocked(f.backend.runner).mockResolvedValue({
      execute: async (input) => {
        const payload = JSON.parse(input.stdin!);
        const ownerRoot = join(temp, payload.owner);
        mkdirSync(ownerRoot, { recursive: true });
        writeFileSync(
          join(ownerRoot, "generation"),
          String(payload.generation),
        );
        const result = spawnSync(
          input.command,
          input.args!.map((arg) =>
            arg.replaceAll("/home/user/.paperclip-owners/", `${temp}/`),
          ),
          {
            input: input.stdin,
            encoding: "utf8",
            timeout: 5000,
            env: { ...process.env, PATH: `${temp}:${process.env.PATH}` },
          },
        );
        if (result.error) throw result.error;
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          timedOut: false,
        } as any;
      },
    });
    try {
      await f.attach();
      const binding = await f.admit();
      const result = await binding.runner.execute({
        command: "sh",
        args: [
          "-c",
          "sleep 30 </dev/null >/dev/null 2>&1 & echo $!; read word; echo $word >&2; exit 7",
        ],
        cwd: temp,
        stdin: "foreground-input\n",
      });
      const stdinProbe = await binding.runner.execute({
        command: "python3",
        args: ["-c", "import os,sys; assert os.fstat(0).st_nlink > 0, 'stdin backing file was unlinked before child exit'; assert os.fstat(0).st_mode & 0o777 == 0o600; print(sys.stdin.read(),end='')"],
        cwd: temp,
        stdin: "persistent-stdin",
      });
      expect(stdinProbe.exitCode).toBe(0);
      expect(stdinProbe.stdout).toBe("persistent-stdin");
      backgroundPid = Number(result.stdout.trim());
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toBe("foreground-input\n");
      expect(backgroundPid).toBeGreaterThan(1);
      expect(() => process.kill(backgroundPid!, 0)).not.toThrow();
      expect(existsSync(join(temp, binding.owner.ownerId))).toBe(true);
    } finally {
      if (backgroundPid) process.kill(backgroundPid, "SIGKILL");
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it("bounds initial seed requests and aborts a failed upload without publishing", async () => {
    const f = fixture();
    await f.attach();
    const files = await f.service.files({ ...f.scope, agentId: "agent" });
    vi.mocked(f.backend.remote).mockImplementation(async (_record, input) => {
      if (input.action === "seed-begin") return { started: true };
      if (input.action === "seed-commit") return { seeded: true };
      return {};
    });
    await expect(files.seedBytes({ "large.bin": Buffer.alloc(2 * 1024 * 1024 + 1) })).resolves.toEqual({ seeded: true });
    const chunks = vi.mocked(f.backend.remote).mock.calls.map(([, input]) => input).filter(input => input.action === "seed-chunk");
    expect(chunks).toHaveLength(3);
    expect(chunks.map(input => input.offset)).toEqual([0, 1024 * 1024, 2 * 1024 * 1024]);
    expect(chunks.every(input => Buffer.from(input.base64 as string, "base64").length <= 1024 * 1024)).toBe(true);
    vi.mocked(f.backend.remote).mockClear();
    await expect(files.seedFiles((async function* () {
      yield { path: "first", offset: 0, bytes: Buffer.from("first") };
      throw new Error("source disappeared");
    })())).rejects.toThrow("source disappeared");
    const actions = vi.mocked(f.backend.remote).mock.calls.map(([, input]) => input.action);
    expect(actions).toEqual(["seed-begin", "seed-chunk", "seed-abort"]);
    vi.mocked(f.backend.remote).mockResolvedValue({ started: false });
    let read = false;
    await expect(files.seedFiles((async function* () { read = true; yield { path: "unused", offset: 0, bytes: Buffer.alloc(0) }; })())).resolves.toEqual({ seeded: false });
    expect(read).toBe(false);
  });
  it("realizes probe cwd before readiness without consuming the initial personal-home seed", async () => {
    const f = fixture();
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "computer-probe-")));
    const local = (value: string) =>
      value.replace("/home/user/paperclip/", `${temp}/`);
    vi.mocked(f.backend.remote).mockImplementation(async (_record, input) => {
      const result = spawnSync(
        "python3",
        ["-c", remoteProgram.replaceAll("/home/user/paperclip/", `${temp}/`)],
        {
          input: JSON.stringify({
            ...input,
            root: local(input.root as string),
          }),
          encoding: "utf8",
        },
      );
      if (result.status !== 0) throw new Error(result.stderr);
      return JSON.parse(result.stdout);
    });
    try {
      await f.attach();
      const probe = await f.service.admitProbe({
        ...f.scope,
        agentId: "agent",
        probeId: "probe",
        idleTimeoutMs: 60_000,
      });
      expect(probe.remoteCwd).not.toBe(probe.agentHome);
      const ready = spawnSync("sh", ["-c", "pwd"], {
        cwd: local(probe.remoteCwd),
        encoding: "utf8",
      });
      expect(ready.status).toBe(0);
      expect(ready.stdout.trim()).toBe(local(probe.remoteCwd));
      expect(existsSync(local(probe.agentHome))).toBe(false);
      const run = await f.admit();
      expect(run.remoteCwd).toBe(probe.agentHome);
      expect(existsSync(local(run.agentHome))).toBe(false);
      const files = await f.service.files({ ...f.scope, agentId: "agent" });
      await expect(
        files.seed({ "AGENTS.md": "initial managed instructions" }),
      ).resolves.toEqual({ seeded: true });
      expect(
        readFileSync(join(local(run.agentHome), "AGENTS.md"), "utf8"),
      ).toBe("initial managed instructions");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it("admits an unsaved-agent probe in a bounded company-scoped temporary home", async () => {
    const f = fixture();
    await f.attach();
    const probe = await f.service.admitProbe({ ...f.scope, probeId: "unsaved", idleTimeoutMs: 60_000 });
    const record = await f.repository.get(f.scope);
    const owner = record.ledger.owners.find((entry) => entry.id === probe.owner.ownerId)!;
    expect(owner.agentId).toBeUndefined();
    expect(owner.runId).toBeUndefined();
    expect(owner.probeId).toBe("unsaved");
    expect(probe.remoteCwd).toBe(`/home/user/paperclip/${f.scope.companyId}/probes/unsaved`);
    expect(probe.agentHome).toBe(probe.remoteCwd);
    expect(Object.keys(record.ledger.placements)).toEqual(["probe-unsaved"]);
    await expect(f.service.realizeWorkspace({ ...f.scope, owner: probe.owner, mode: "shared" }))
      .resolves.toMatchObject({ remoteCwd: probe.remoteCwd, agentHome: probe.agentHome });
    await expect(f.service.realizeWorkspace({ ...f.scope, owner: probe.owner, mode: "shared", projectId: "project" }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(f.service.admitProbe({ ...f.scope, companyId: "foreign", probeId: "other", idleTimeoutMs: 60_000 }))
      .rejects.toMatchObject({ code: "not_found" });
    f.advance(60_001);
    await f.service.reconcile();
    expect(f.repository.runState).not.toHaveBeenCalled();
    expect(f.backend.retire).toHaveBeenCalledOnce();
  });
  it("still requires an agent for a real heartbeat admission", async () => {
    const f = fixture();
    await f.attach();
    await expect(f.service.admit({ ...f.scope, runId: "run", sessionKey: "session", idleTimeoutMs: 60_000 }))
      .rejects.toMatchObject({ code: "invalid" });
  });
  it("gives harness probes a finite owner without fabricating a heartbeat run", async () => {
    const f = fixture();
    await f.attach();
    const probe = await f.service.admitProbe({
      ...f.scope,
      agentId: "agent",
      probeId: "probe",
      idleTimeoutMs: 60_000,
    });
    await expect(
      f.service.retainWarm({
        ...f.scope,
        owner: probe.owner,
        idleTimeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    f.advance(60_001);
    await f.service.reconcile();
    expect(f.repository.runState).not.toHaveBeenCalled();
    expect(f.backend.retire).toHaveBeenCalledOnce();
  });
});


describe("computer retirement proof", () => {
  it("proves only the exact retired run without provider actions", async () => {
    const f = fixture();
    await f.attach();
    const binding = await f.admit();
    const input = { ...f.scope, owner: binding.owner, agentId: "agent", runId: "run" };
    expect(await f.service.isRetired(input)).toBe(false);
    expect(f.backend.retire).not.toHaveBeenCalled();
    await f.service.retire(input);
    vi.mocked(f.backend.retire).mockClear();
    vi.mocked(f.backend.inspect).mockClear();
    expect(await f.service.isRetired(input)).toBe(true);
    for (const change of [
      { agentId: "other-agent" },
      { runId: "other-run" },
      { owner: { ...binding.owner, computerId: "other-computer" } },
      { owner: { ...binding.owner, ownerId: "other-owner" } },
      { owner: { ...binding.owner, generation: binding.owner.generation + 1 } },
    ]) expect(await f.service.isRetired({ ...input, ...change })).toBe(false);
    await expect(f.service.isRetired({ ...input, companyId: "other-company" })).rejects.toMatchObject({ code: "not_found" });
    expect(f.backend.retire).not.toHaveBeenCalled();
    expect(f.backend.inspect).not.toHaveBeenCalled();
  });
});


describe("computer graceful retirement", () => {
  it("fences admission and ordinary execution while allowing the exact pinned process to close", async () => {
    const f = fixture();
    await f.attach();
    const binding = await f.admit();
    await binding.launch({ command: "runner" });
    let finish!: () => void;
    let entered!: () => void;
    const closing = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const beforeStop = vi.fn(async () => { entered(); await closing; });
    const retiring = f.service.retire({ ...f.scope, owner: binding.owner, beforeStop });
    await started;
    expect((await f.repository.get(f.scope)).ledger.owners[0]).toMatchObject({ phase: "retiring" });
    await expect(f.admit()).rejects.toMatchObject({ code: "conflict" });
    await expect(binding.runner.execute({ command: "forbidden" })).rejects.toMatchObject({ code: "conflict" });
    await expect(binding.launch({ command: "forbidden" })).rejects.toMatchObject({ code: "conflict" });
    await binding.process.runner.execute({ command: "close" });
    await binding.process.ingress();
    expect(f.backend.retire).not.toHaveBeenCalled();
    const repeated = f.service.retire({ ...f.scope, owner: binding.owner, beforeStop });
    finish();
    expect(await retiring).toEqual({ retired: true });
    expect(await repeated).toEqual({ retired: true });
    expect(beforeStop).toHaveBeenCalledOnce();
    expect(f.backend.retire).toHaveBeenCalledOnce();
    await expect(binding.process.ingress()).rejects.toMatchObject({ code: "conflict" });
    expect((await f.admit()).owner.ownerId).not.toBe(binding.owner.ownerId);
  });
  it("never invokes a stale generation callback and always stops after callback failure", async () => {
    const f = fixture();
    await f.attach();
    const old = await f.admit();
    await old.launch({ command: "runner" });
    await f.service.retainWarm({ ...f.scope, owner: old.owner, idleTimeoutMs: 60_000 });
    const current = await f.admit();
    const stale = vi.fn(async () => {});
    expect(await f.service.retire({ ...f.scope, owner: old.owner, beforeStop: stale })).toEqual({ retired: false });
    expect(stale).not.toHaveBeenCalled();
    expect(await f.service.retire({ ...f.scope, owner: current.owner, beforeStop: async () => { throw new Error("provider close failed"); } })).toEqual({ retired: true });
    expect(f.backend.retire).toHaveBeenCalledOnce();
  });
  it("bounds a stalled graceful close and denies late process control", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.attach();
      const binding = await f.admit();
      await binding.launch({ command: "runner" });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const retiring = f.service.retire({ ...f.scope, owner: binding.owner, beforeStop: async () => {
        entered(); await new Promise<void>(() => {});
      } });
      await started;
      f.advance(30_001);
      await expect(binding.process.runner.execute({ command: "late" })).rejects.toMatchObject({ code: "conflict" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await retiring).toEqual({ retired: true });
      expect(f.backend.retire).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("does not extend the original warm shutdown deadline when retirement starts late", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.attach();
      const binding = await f.admit();
      await binding.launch({ command: "runner" });
      await f.service.retainWarm({ ...f.scope, owner: binding.owner, idleTimeoutMs: 60_000 });
      f.advance(80_000);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const retiring = f.service.retire({ ...f.scope, owner: binding.owner, beforeStop: async () => {
        entered(); await new Promise<void>(() => {});
      } });
      await started;
      expect((await f.repository.get(f.scope)).ledger.owners[0]!.retirementDeadline).toBe("2026-10-10T12:01:30.000Z");
      f.advance(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await retiring).toEqual({ retired: true });
      expect(f.backend.retire).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("reconciles a crashed controller reservation only after its durable deadline", async () => {
    const f = fixture();
    await f.attach();
    const binding = await f.admit();
    await binding.launch({ command: "runner" });
    await f.repository.update(f.scope, (record) => {
      record.ledger.owners[0]!.phase = "retiring";
      record.ledger.owners[0]!.retirementDeadline = "2026-10-10T12:00:30.000Z";
    });
    await f.service.reconcile();
    expect(f.backend.retire).not.toHaveBeenCalled();
    await expect(f.service.retire({ ...f.scope, owner: binding.owner })).rejects.toMatchObject({ code: "conflict" });
    f.advance(30_001);
    await f.service.reconcile();
    expect(f.backend.retire).toHaveBeenCalledOnce();
    expect((await f.repository.get(f.scope)).ledger.owners[0]!.phase).toBe("retired");
  });
});
