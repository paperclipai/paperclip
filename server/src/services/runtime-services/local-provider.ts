import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { readLocalServicePortOwner, isLocalServiceProcessOwnedBy } from "../local-service-supervisor.js";
import type { RuntimeServiceProcessRef, RuntimeServiceProvider, RuntimeServiceProviderContext } from "./provider.js";
import { runtimeServiceLocalHostSource, runtimeServiceStorageSource } from "@paperclipai/plugin-sdk";
import { createLocalProcessHandoff } from "./local-process-handoff.js";
import { RuntimeServiceFault } from "./fault.js";

const execFileAsync = promisify(execFile);
const uuid = /^[a-f0-9-]{36}$/i;

interface Receipt {
  generation: string;
  ports: Record<string, number>;
  pid: number;
  identity: string;
  childPid: number | null;
  childIdentity: string | null;
  state: "starting" | "running" | "stopping" | "exited";
  exitCode: number | null;
}

async function processIdentity(pid: number): Promise<string | null> {
  try {
    if (!Number.isInteger(pid) || pid <= 1) return null;
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const init = await fs.readFile("/proc/1/stat", "utf8");
      return `${init.slice(init.lastIndexOf(")") + 2).split(" ")[19]}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3000 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function matchingProcess(pid: number | null, identity: string | null) {
  return pid !== null && identity !== null && await processIdentity(pid) === identity;
}

async function reservePort(requested?: number): Promise<{ port: number; release: () => Promise<void> }> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(requested ?? 0, "127.0.0.1", resolve);
  });
  const port = (socket.address() as net.AddressInfo).port;
  return { port, release: () => new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve())) };
}

export function createLocalRuntimeServiceProvider(options: {
  root?: string;
  baseEnv?: Record<string, string>;
  prepareLaunch?: (context: RuntimeServiceProviderContext, env: Record<string, string>) => Promise<{ executable: string; args: string[]; env: Record<string, string> }>;
} = {}): RuntimeServiceProvider {
  const root = options.root ?? path.join(resolvePaperclipInstanceRoot(), "runtime-services-v2");
  function files(context: RuntimeServiceProviderContext) {
    if (![context.companyId, context.serviceId, context.process.generation].every((value) => uuid.test(value))) throw new Error("Invalid service process identity");
    const directory = path.join(root, context.companyId, context.serviceId);
    return { directory, receipt: path.join(directory, `${context.process.generation}.json`), log: path.join(directory, "output.log") };
  }
  async function readReceipt(context: RuntimeServiceProviderContext): Promise<Receipt | null> {
    try {
      const receipt = JSON.parse(await fs.readFile(files(context).receipt, "utf8")) as Receipt;
      if (receipt.generation !== context.process.generation || !Number.isInteger(receipt.pid) || typeof receipt.identity !== "string") throw new Error("Service process receipt has an invalid identity");
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  function ports(context: RuntimeServiceProviderContext) {
    return (context.process.ports ?? {}) as Record<string, number>;
  }
  return {
    key: "local",
    ...createLocalProcessHandoff(),
    capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
    async storageUsage(context) {
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const command = [process.execPath, "-e", runtimeServiceStorageSource, context.spec.cwd].map(quote).join(" ");
      const env = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C", HOME: context.spec.cwd };
      const request = { ...context, spec: { ...context.spec, command }, env: {}, secrets: [] };
      const launch = options.prepareLaunch ? await options.prepareLaunch(request, env)
        : { executable: process.execPath, args: ["-e", runtimeServiceStorageSource, context.spec.cwd], env };
      const { stdout } = await execFileAsync(launch.executable, launch.args, { cwd: context.spec.cwd, env: launch.env, timeout: 12_000, maxBuffer: 64 * 1024 });
      const result = JSON.parse(stdout) as { bytes: number };
      if (!Number.isSafeInteger(result.bytes) || result.bytes < 0) throw new Error("Workspace measurement unavailable");
      return { bytes: result.bytes };
    },
    async start(context): Promise<RuntimeServiceProcessRef> {
      if (process.platform === "win32") throw new RuntimeServiceFault("unsupported_platform");
      const previous = await readReceipt(context);
      if (previous) {
        // A dead generation must be retried through a new persisted generation.
        if (!await matchingProcess(previous.pid, previous.identity)) throw new Error("Service process generation already exited");
        return { ...context.process, ports: previous.ports, started: true };
      }
      if (context.process.started) throw new RuntimeServiceFault("supervisor_lost");
      const location = files(context);
      await fs.mkdir(location.directory, { recursive: true, mode: 0o700 });
      const sourceDigest = createHash("sha256").update(runtimeServiceLocalHostSource).digest("hex");
      const helper = path.join(root, `host-${sourceDigest}.cjs`);
      await fs.writeFile(helper, runtimeServiceLocalHostSource, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const reservations: Awaited<ReturnType<typeof reservePort>>[] = [];
      const allocated: Record<string, number> = {};
      try {
        for (const endpoint of context.spec.endpoints) {
          const reservation = await reservePort(ports(context)[endpoint.name] ?? endpoint.port);
          reservations.push(reservation);
          allocated[endpoint.name] = reservation.port;
        }
      } finally {
        await Promise.all(reservations.map((reservation) => reservation.release()));
      }
      // Do not inherit the control plane's secrets or loader configuration.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        HOME: context.spec.cwd,
        HOST: "127.0.0.1",
        ...options.baseEnv,
        ...context.env,
      };
      for (const endpoint of context.spec.endpoints) env[endpoint.portEnv] = String(allocated[endpoint.name]);
      const launch = options.prepareLaunch ? await options.prepareLaunch(context, env) : { executable: "/bin/sh", args: ["-c", context.spec.command], env };
      const child = spawn(process.execPath, [helper, location.receipt, location.log], {
        cwd: context.spec.cwd, detached: true, env: { PATH: env.PATH }, stdio: ["pipe", "ignore", "ignore"],
      });
      const started = new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ generation: context.process.generation, ports: allocated, command: context.spec.command, cwd: context.spec.cwd, ...launch, secrets: context.secrets }));
      await started;
      child.unref();
      const next = { ...context.process, ports: allocated, started: true };
      for (let attempt = 0; attempt < 100; attempt++) {
        const receipt = await readReceipt(context);
        if (receipt) return { ...next, ports: receipt.ports };
        if (child.exitCode !== null) throw new Error("Service supervisor exited before recording its identity");
        await delay(25);
      }
      // Fail safely rather than leaving an untracked supervisor running.
      child.kill("SIGTERM");
      throw new Error("Service supervisor did not record its identity");
    },
    async inspect(context) {
      const receipt = await readReceipt(context);
      if (!receipt && context.process.started) throw new RuntimeServiceFault("supervisor_lost");
      if (!receipt) return { state: "missing", endpoints: [] };
      const recovered = { ...context.process, ports: receipt.ports, started: true };
      const running = receipt.state !== "exited" && await matchingProcess(receipt.pid, receipt.identity);
      if (!running) return { state: "exited", processRef: recovered, exitCode: receipt.exitCode, endpoints: [] };
      const endpoints = await Promise.all(context.spec.endpoints.map(async (endpoint) => {
        const port = receipt.ports[endpoint.name];
        if (!port || !receipt.childPid) return { name: endpoint.name, port: port ?? 0, healthy: false };
        const owner = await readLocalServicePortOwner(port);
        if (!owner || !await isLocalServiceProcessOwnedBy(owner, receipt.childPid)) return { name: endpoint.name, port, healthy: false };
        try {
          const response = await fetch(`http://127.0.0.1:${port}${endpoint.healthPath}`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
          await response.body?.cancel();
          return { name: endpoint.name, port, healthy: response.status >= 200 && response.status < 400 };
        } catch { return { name: endpoint.name, port, healthy: false }; }
      }));
      return { state: "running", processRef: recovered, endpoints };
    },
    async upstream(context, endpointName) {
      const observation = await this.inspect(context);
      const endpoint = observation.endpoints.find((item) => item.name === endpointName);
      if (observation.state !== "running" || !endpoint?.healthy) throw new Error("Service endpoint is not healthy or owned by this process");
      return { url: `http://127.0.0.1:${endpoint.port}`, headers: {} };
    },
    async stop(context) {
      let receipt = await readReceipt(context);
      if (!receipt) {
        if (context.process.started) throw new RuntimeServiceFault("supervisor_lost");
        const location = files(context);
        await fs.mkdir(location.directory, { recursive: true, mode: 0o700 });
        const cancelled: Receipt = {
          generation: context.process.generation, ports: {}, pid: 0, identity: "cancelled",
          childPid: null, childIdentity: null, state: "exited", exitCode: null,
        };
        const claim = `${location.receipt}.${randomUUID()}.claim`;
        await fs.writeFile(claim, JSON.stringify(cancelled), { flag: "wx", mode: 0o600 });
        try {
          await fs.link(claim, location.receipt);
          return;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        finally { await fs.unlink(claim); }
        // The supervisor won the atomic claim while stop was writing its fence.
        receipt = await readReceipt(context);
        if (!receipt) throw new Error("Service receipt disappeared during termination");
      }
      if (await matchingProcess(receipt.pid, receipt.identity)) {
        try { process.kill(receipt.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!await matchingProcess(receipt.pid, receipt.identity) && !await matchingProcess(receipt.childPid, receipt.childIdentity)) return;
        await delay(50);
      }
      // Identity checks prevent PID reuse from targeting another task's process.
      if (receipt.childPid && await matchingProcess(receipt.childPid, receipt.childIdentity)) process.kill(-receipt.childPid, "SIGKILL");
      if (await matchingProcess(receipt.pid, receipt.identity)) process.kill(receipt.pid, "SIGKILL");
      await delay(50);
      if (await matchingProcess(receipt.pid, receipt.identity) || await matchingProcess(receipt.childPid, receipt.childIdentity)) throw new Error("Service process termination could not be verified");
    },
    async logs(context, limitBytes) {
      const limit = Math.max(1, Math.min(limitBytes, 128 * 1024));
      try {
        const handle = await fs.open(files(context).log, "r");
        try {
          const size = (await handle.stat()).size;
          const data = Buffer.alloc(Math.min(size, limit));
          const result = await handle.read(data, 0, data.length, Math.max(0, size - limit));
          return data.subarray(0, result.bytesRead).toString("utf8");
        } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
    },
  };
}
