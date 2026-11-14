import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { NativePredecessorRetirementUnprovenError } from "./predecessor-retirement.js";
import { retireSandboxRunnerPortHolders } from "./sandbox-runner-port-holders.js";

const HOLDER_SCRIPT = 'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1", () => process.stdout.write("ready\\n"));';

describeEmbeddedPostgres("a sandbox Runner port held by another session's Runner", () => {
  const environment = nativeRestartFixture();
  const holders: ChildProcess[] = [];
  afterEach(() => { for (const holder of holders.splice(0)) if (holder.exitCode === null) holder.kill("SIGKILL"); });

  const confinedCommands: string[][] = [];
  const confinedRunner = (base: string) => ({ execute: async (request: { command: string; args?: string[] }) => {
    const operands = (request.args ?? []).slice(2);
    confinedCommands.push(operands);
    if (operands.some(operand => operand.startsWith("/") && !operand.startsWith(`${base}/`))) {
      return { exitCode: 126, timedOut: false, stdout: "", stderr: "outside sandbox" };
    }
    const result = spawnSync(request.command, request.args ?? [], { encoding: "utf8", timeout: 20_000, cwd: base });
    return { exitCode: result.status, timedOut: result.error !== undefined, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } });

  async function freePort() {
    const probe = createServer();
    await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(done => probe.close(() => done()));
    return port;
  }

  async function bind(port: number): Promise<"bound" | string> {
    return new Promise(done => {
      const contender = createServer();
      contender.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "error"));
      contender.listen(port, "127.0.0.1", () => contender.close(() => done("bound")));
    });
  }

  async function startHolder(input: { runtimeRoot: string; session: string; runId: string; port: number;
    lifecycle?: string; outbox?: readonly unknown[]; pendingProviderCleanup?: unknown }) {
    const runnerInstanceId = `runner-${randomUUID()}`;
    const holder = spawn(process.execPath, ["-e", HOLDER_SCRIPT, String(input.port), "--runner-id", runnerInstanceId],
      { stdio: ["ignore", "pipe", "ignore"] });
    holders.push(holder);
    await new Promise<void>((done, fail) => {
      holder.stdout!.once("data", () => done());
      holder.once("exit", code => fail(new Error(`holder exited ${code}`)));
    });
    const directory = join(input.runtimeRoot, "sessions", input.session, "runner");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "runner-process.identity"),
      `holdernonce\n${holder.pid}\n${new Date().toISOString()}\n${runnerInstanceId}\n${await processFingerprint(holder.pid!)}`);
    await writeFile(join(directory, "runner-state.json"), JSON.stringify({ runnerInstanceId, runId: input.runId,
      lifecycle: input.lifecycle ?? "ready", outbox: input.outbox ?? [], pendingTerminalDelivery: null,
      pendingProviderCleanup: input.pendingProviderCleanup ?? null, warmTransition: null }));
    return holder;
  }

  async function processFingerprint(pid: number) {
    if (process.platform !== "linux") return "";
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const ticks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return `linux:${boot}:${ticks}\n`;
  }

  async function exited(holder: ChildProcess) {
    if (holder.exitCode !== null || holder.signalCode !== null) return true;
    return new Promise<boolean>(done => {
      const timer = setTimeout(() => done(false), 5_000);
      holder.once("exit", () => { clearTimeout(timer); done(true); });
    });
  }

  async function scenario(label: string, holderStatus: "succeeded" | "running" | "cancelled" | null, state: { lifecycle?: string; outbox?: readonly unknown[]; pendingProviderCleanup?: unknown } = {}) {
    const predecessor = await environment.seedRun(`PORT-HOLDER-PREV-${label}`);
    const current = await environment.seedRun(`PORT-HOLDER-NEXT-${label}`, predecessor.db);
    if (holderStatus) await predecessor.db.update(heartbeatRuns).set({ status: holderStatus }).where(eq(heartbeatRuns.id, predecessor.runId));
    const base = join(environment.current.runtimeRoot, `sandbox-${label}`);
    const runtimeRoot = join(base, ".paperclip-runtime", "paperclip-runner");
    const port = await freePort();
    const holder = await startHolder({ runtimeRoot, session: "a".repeat(64), runId: holderStatus ? predecessor.runId : randomUUID(), port, ...state });
    const retire = () => retireSandboxRunnerPortHolders({ db: current.db, companyId: environment.current.companyId,
      agentId: environment.current.agentId, runId: current.runId, runner: confinedRunner(base) as never, runtimeRoot,
      ownSessionRoot: join(runtimeRoot, "sessions", "b".repeat(64)), providerLeaseId: "sandbox-1",
      retireInProcess: async () => false, waitMs: 3_000, pollMs: 100 });
    return { predecessor, current, holder, port, retire };
  }

  it("stops a finished run's idle Runner that holds the port, so the next Runner binds", async () => {
    const { predecessor, current, holder, port, retire } = await scenario("finished", "succeeded");
    expect(await bind(port)).toBe("EADDRINUSE");
    await expect(retire()).resolves.toEqual([predecessor.runId]);
    expect(await exited(holder)).toBe(true);
    expect(await bind(port)).toBe("bound");
    expect(confinedCommands.flat().filter(operand => operand.startsWith("/")).every(operand => operand.startsWith(`${environment.current.runtimeRoot}/sandbox-finished/`))).toBe(true);
    const [activity] = await current.db.select().from(activityLog).where(and(
      eq(activityLog.runId, current.runId), eq(activityLog.action, "native.runner_port_holder_retired")));
    expect(activity?.details).toMatchObject({ holderRunId: predecessor.runId, holderStatus: "succeeded", providerLeaseId: "sandbox-1" });
  });

  it.each([
    ["a live run", "running", {}, "runner_port_holder_owner_not_settled"],
    ["a run with work in its outbox", "succeeded", { outbox: [{ seq: 1 }] }, "runner_port_holder_owner_not_settled"],
    ["a run whose provider cleanup is pending", "cancelled", { pendingProviderCleanup: { reason: "fixture" } }, "runner_port_holder_owner_not_settled"],
    ["no recorded run", null, {}, "runner_port_holder_unknown_owner"],
  ] as const)("never stops a holder owned by %s and sends the run to a fresh sandbox", async (_name, status, state, reason) => {
    const { holder, port, retire } = await scenario(`kept-${reason}-${status}`, status, state);
    const failure = await retire().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(NativePredecessorRetirementUnprovenError);
    expect(((failure as Error).cause as Error).message).toBe(reason);
    expect(holder.exitCode).toBeNull();
    expect(await bind(port)).toBe("EADDRINUSE");
  });

  it("ignores this run's own session, moved-aside roots and holders that already exited", async () => {
    const current = await environment.seedRun("PORT-HOLDER-OWN");
    const base = join(environment.current.runtimeRoot, "sandbox-own");
    const runtimeRoot = join(base, ".paperclip-runtime", "paperclip-runner");
    const own = await startHolder({ runtimeRoot, session: "b".repeat(64), runId: current.runId, port: await freePort() });
    const aside = await startHolder({ runtimeRoot, session: `${"c".repeat(64)}.bootstrap-restart-1`, runId: randomUUID(), port: await freePort() });
    const gone = await startHolder({ runtimeRoot, session: "d".repeat(64), runId: randomUUID(), port: await freePort() });
    gone.kill("SIGKILL");
    expect(await exited(gone)).toBe(true);
    await expect(retireSandboxRunnerPortHolders({ db: current.db, companyId: environment.current.companyId,
      agentId: environment.current.agentId, runId: current.runId, runner: confinedRunner(base) as never, runtimeRoot,
      ownSessionRoot: join(runtimeRoot, "sessions", "b".repeat(64)), providerLeaseId: "sandbox-1",
      retireInProcess: async () => false })).resolves.toEqual([]);
    expect(own.exitCode).toBeNull();
    expect(aside.exitCode).toBeNull();
  });
});
