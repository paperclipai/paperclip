import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import {
  chainBelongsToAgentRun,
  createLocalAgentProcessBoundary,
  defaultLocalProcessInspector,
  type LocalProcessInspector,
  findPeerPidInDarwinNetstat,
  findSocketInProcNet,
} from "../middleware/local-agent-process-boundary.js";

const supported = process.platform === "linux" || process.platform === "darwin";

function startServer(
  serverEnvironment: NodeJS.ProcessEnv,
  host = "127.0.0.1",
  inspector?: LocalProcessInspector,
): Promise<{ server: Server; url: string }> {
  const app = express();
  app.use(actorMiddleware({} as Db, {
    deploymentMode: "local_trusted",
    localAgentProcessBoundary: createLocalAgentProcessBoundary({ serverEnvironment, inspector }),
  }));
  app.get("/api/whoami", (req, res) => {
    res.json({ type: req.actor.type, source: req.actor.source ?? null });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/api/whoami` });
    });
  });
}

const fetchScript = "fetch(process.argv[1]).then(r => r.text()).then(t => process.stdout.write(t))";

let launchedPid: number | undefined;

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ type: string; source: string | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env, timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(JSON.parse(stdout));
    });
    launchedPid = child.pid;
  });
}

function operatorEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_RUNNER_INSTANCE_ID"]) {
    delete env[key];
  }
  return env;
}

describe.skipIf(!supported)("implicit local board access from local processes", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    ({ server, url } = await startServer({}));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("keeps board access for an operator process without credentials", async () => {
    await expect(runChild(process.execPath, ["-e", fetchScript, url], operatorEnvironment()))
      .resolves.toEqual({ type: "board", source: "local_implicit" });
  });

  it("keeps board access for requests from the server process itself", async () => {
    const body = await fetch(url).then((response) => response.json());
    expect(body).toEqual({ type: "board", source: "local_implicit" });
  });

  it("refuses board access to an agent-run process calling without credentials", async () => {
    await expect(runChild(process.execPath, ["-e", fetchScript, url], {
      ...operatorEnvironment(),
      PAPERCLIP_RUN_ID: "11111111-1111-4111-8111-111111111111",
    })).resolves.toEqual({ type: "none", source: "none" });
  });

  it("refuses board access when an agent's tool clears its environment before calling", async () => {
    const agentProcess = [
      "const { execFileSync } = require('node:child_process');",
      "process.stdout.write(execFileSync(process.execPath, ['-e', process.argv[1], process.argv[2]], { env: {} }));",
    ].join("\n");
    await expect(runChild(process.execPath, ["-e", agentProcess, fetchScript, url], {
      ...operatorEnvironment(),
      PAPERCLIP_AGENT_ID: "22222222-2222-4222-8222-222222222222",
    })).resolves.toEqual({ type: "none", source: "none" });
  });

  it("keeps board access for an operator whose own server runs inside the same agent execution", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const nested = await startServer({ PAPERCLIP_RUN_ID: runId });
    try {
      await expect(runChild(process.execPath, ["-e", fetchScript, nested.url], {
        ...operatorEnvironment(),
        PAPERCLIP_RUN_ID: runId,
      })).resolves.toEqual({ type: "board", source: "local_implicit" });
    } finally {
      await new Promise((resolve) => nested.server.close(resolve));
    }
  });
});

const nonDumpableFetch = [
  "import ctypes, sys, urllib.request",
  "ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)",
  "sys.stdout.write(urllib.request.urlopen(sys.argv[1]).read().decode())",
].join("\n");

const launchNonDumpableFetch = [
  "const { execFileSync } = require('node:child_process');",
  "const env = process.argv[3] === 'clear' ? { PATH: process.env.PATH } : process.env;",
  "process.stdout.write(execFileSync('python3', ['-c', process.argv[1], process.argv[2]], { env }));",
].join("\n");

const idleNonDumpable = [
  "import ctypes, time",
  "ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)",
  "time.sleep(600)",
].join("\n");

async function startIdleAgentRunProcess(): Promise<{ child: ChildProcess; uninspectable: boolean }> {
  const child = spawn("python3", ["-c", idleNonDumpable], {
    env: { ...operatorEnvironment(), PAPERCLIP_RUN_ID: "77777777-7777-4777-8777-777777777777" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const uninspectable = await readdir(`/proc/${child.pid}/fd`)
      .then(() => false, (error: NodeJS.ErrnoException) => error.code === "EACCES" || error.code === "EPERM");
    if (uninspectable) return { child, uninspectable };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { child, uninspectable: false };
}

function inspectorForLaunchedProcesses(): LocalProcessInspector {
  const linux = defaultLocalProcessInspector("linux")!;
  return {
    ...linux,
    async findPeerPids(sockets) {
      const owners = await linux.findPeerPids(sockets);
      if (owners === "unsupported") return owners;
      const root = launchedPid;
      return Promise.all(owners.map(async (owner) => {
        if (owner === null || typeof owner !== "object") return owner;
        const launched = await Promise.all(owner.candidates.map(async (pid) =>
          root !== undefined && (await linux.ancestorPids(pid))?.includes(root) ? [pid] : []));
        return { candidates: launched.flat() };
      }));
    },
  };
}

describe.skipIf(process.platform !== "linux").each(["127.0.0.1", "::1"])(
  "implicit local board access from Linux processes over %s loopback",
  (host) => {
    let server: Server;
    let url: string;
    let otherAgentRun: { child: ChildProcess; uninspectable: boolean };

    beforeAll(async () => {
      otherAgentRun = await startIdleAgentRunProcess();
      ({ server, url } = await startServer({}, host, inspectorForLaunchedProcesses()));
    });

    afterAll(async () => {
      otherAgentRun.child.kill();
      await new Promise((resolve) => server.close(resolve));
    });

    it("refuses board access to an operator process the server cannot inspect while another agent run's process it cannot inspect is running", async (context) => {
      if (!otherAgentRun.uninspectable) context.skip();
      const hostWide = await startServer({}, host);
      try {
        await expect(runChild(process.execPath, ["-e", launchNonDumpableFetch, nonDumpableFetch, hostWide.url, "keep"], operatorEnvironment()))
          .resolves.toEqual({ type: "none", source: "none" });
      } finally {
        await new Promise((resolve) => hostWide.server.close(resolve));
      }
    });

    it("keeps board access for an operator process", async () => {
      await expect(runChild(process.execPath, ["-e", fetchScript, url], operatorEnvironment()))
        .resolves.toEqual({ type: "board", source: "local_implicit" });
    });

    it("refuses board access to an agent-run process", async () => {
      await expect(runChild(process.execPath, ["-e", fetchScript, url], {
        ...operatorEnvironment(),
        PAPERCLIP_RUN_ID: "44444444-4444-4444-8444-444444444444",
      })).resolves.toEqual({ type: "none", source: "none" });
    });

    it("keeps board access for an operator process the server cannot inspect", async () => {
      await expect(runChild(process.execPath, ["-e", launchNonDumpableFetch, nonDumpableFetch, url, "keep"], operatorEnvironment()))
        .resolves.toEqual({ type: "board", source: "local_implicit" });
    });

    it("refuses board access to an agent-run process the server cannot inspect", async () => {
      await expect(runChild(process.execPath, ["-e", launchNonDumpableFetch, nonDumpableFetch, url, "clear"], {
        ...operatorEnvironment(),
        PAPERCLIP_AGENT_ID: "55555555-5555-4555-8555-555555555555",
      })).resolves.toEqual({ type: "none", source: "none" });
    });

    it("refuses board access to an uninspectable agent-run process without a readable parent", async () => {
      await expect(runChild("python3", ["-c", nonDumpableFetch, url], {
        ...operatorEnvironment(),
        PAPERCLIP_RUN_ID: "66666666-6666-4666-8666-666666666666",
      })).resolves.toEqual({ type: "none", source: "none" });
    });
  },
);

describe("local process identification", () => {
  it("finds the client socket in a Linux TCP table", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0C1C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0",
      "   1: 0100007F:D431 0100007F:0C1C 01 00000000:00000000 00:00000000 00000000  1000        0 222 1 0 20 4 30 10 -1",
      "   2: 0100007F:0C1C 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0 20 4 30 10 -1",
    ].join("\n");
    expect(findSocketInProcNet(table, { address: "127.0.0.1", port: 54321 }, { address: "127.0.0.1", port: 3100 }))
      .toEqual({ inode: "222", uid: 1000 });
  });

  it("finds IPv6 and IPv4-mapped loopback client sockets in a Linux TCP6 table", () => {
    const table = [
      "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000001000000:D431 00000000000000000000000001000000:0C1C 01 00000000:00000000 00:00000000 00000000  1001        0 444 1 0 20 4 30 10 -1",
      "   1: 0000000000000000FFFF00000100007F:D432 0000000000000000FFFF00000100007F:0C1C 01 00000000:00000000 00:00000000 00000000  1002        0 555 1 0 20 4 30 10 -1",
    ].join("\n");
    expect(findSocketInProcNet(table, { address: "::1", port: 54321 }, { address: "::1", port: 3100 }))
      .toEqual({ inode: "444", uid: 1001 });
    expect(findSocketInProcNet(table, { address: "127.0.0.1", port: 54322 }, { address: "127.0.0.1", port: 3100 }))
      .toEqual({ inode: "555", uid: 1002 });
  });

  it("finds the client process in macOS netstat output and refuses unknown formats", () => {
    const output = [
      "Active Internet connections (including servers)",
      "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)      rxbytes txbytes rhiwat shiwat process:pid state options",
      "tcp4       0      0  127.0.0.1.3100         127.0.0.1.54321        ESTABLISHED  0 0 408300 146988 node:100 00002 00000000",
      "tcp4       0      0  127.0.0.1.54321        127.0.0.1.3100         ESTABLISHED  0 0 408300 146988 Google Chrome He:200 00002 00000000",
    ].join("\n");
    const peer = { address: "127.0.0.1", port: 54321 };
    const server = { address: "127.0.0.1", port: 3100 };
    expect(findPeerPidInDarwinNetstat(output, peer, server)).toBe(200);
    expect(findPeerPidInDarwinNetstat(output.replace("process:pid", "pid"), peer, server)).toBe("unsupported");
  });

  it("treats processes under the runner daemon as an agent run but not the daemon itself", () => {
    const daemon = { pid: 10, ppid: 1, executable: "/opt/paperclip/paperclip-runnerd", environment: new Map() };
    const shell = { pid: 11, ppid: 10, executable: "/bin/bash", environment: new Map() };
    expect(chainBelongsToAgentRun([daemon], {})).toBe(false);
    expect(chainBelongsToAgentRun([shell, daemon], {})).toBe(true);
  });
});

describe("process lookups under connection bursts", () => {
  it("shares one lookup at a time across parallel connections and keeps the server responsive", async () => {
    let active = 0;
    let maxActive = 0;
    let scans = 0;
    const scannedSockets: number[] = [];
    const inspector: LocalProcessInspector = {
      async findPeerPids(sockets) {
        scans += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        scannedSockets.push(sockets.length);
        await new Promise((resolve) => setTimeout(resolve, 300));
        active -= 1;
        return sockets.map(() => 4242);
      },
      async ancestries(pids) {
        return new Map(pids.map((pid) => [pid, [{ pid, ppid: 1, executable: "/usr/bin/browser", environment: new Map() }]]));
      },
      async ancestorPids(pid) {
        return [pid];
      },
    };
    const app = express();
    app.use(actorMiddleware({} as Db, {
      deploymentMode: "local_trusted",
      localAgentProcessBoundary: createLocalAgentProcessBoundary({ inspector, serverEnvironment: {} }),
    }));
    app.get("/api/whoami", (req, res) => { res.json({ type: req.actor.type }); });
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const { port } = server.address() as AddressInfo;
    const request = (abortAfterMs?: number) => new Promise<string>((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/whoami", agent: false }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve(body));
      });
      req.on("error", () => resolve("aborted"));
      if (abortAfterMs !== undefined) setTimeout(() => req.destroy(), abortAfterMs);
    });
    try {
      const timerStarted = Date.now();
      const timerDelay = new Promise<number>((resolve) => setTimeout(() => resolve(Date.now() - timerStarted - 50), 50));
      const first = await Promise.all([
        ...Array.from({ length: 12 }, () => request()),
        request(20),
        request(20),
        timerDelay,
      ]);
      const bodies = first.slice(0, 12);
      expect(bodies.every((body) => JSON.parse(body as string).type === "board")).toBe(true);
      expect(first.slice(12, 14)).toEqual(["aborted", "aborted"]);
      expect(first[14] as number).toBeLessThan(250);
      expect(maxActive).toBe(1);
      expect(scans).toBeLessThanOrEqual(2);
      const scanned = scannedSockets.reduce((sum, count) => sum + count, 0);
      expect(scanned).toBeGreaterThanOrEqual(12);
      expect(scanned).toBeLessThanOrEqual(14);
      expect(JSON.parse(await request())).toEqual({ type: "board" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("process lookups for a mixed batch", () => {
  it("keeps an identified agent process refused when another connection in the batch cannot be identified", async () => {
    const inspector: LocalProcessInspector = {
      async findPeerPids(sockets) {
        return sockets.map((socket) => socket.remotePort === 1001 ? "unsupported" : 2002);
      },
      async ancestries(pids) {
        return new Map(pids.map((pid) => [pid, [{
          pid, ppid: 1, executable: "/usr/bin/agent", environment: new Map([["PAPERCLIP_RUN_ID", "run-1"]]),
        }]]));
      },
      async ancestorPids(pid) {
        return [pid];
      },
    };
    const boundary = createLocalAgentProcessBoundary({ inspector, serverEnvironment: {} });
    const hidden = { remoteAddress: "127.0.0.1", remotePort: 1001, localAddress: "127.0.0.1", localPort: 3100 };
    const agent = { remoteAddress: "127.0.0.1", remotePort: 1002, localAddress: "127.0.0.1", localPort: 3100 };
    const [hiddenResult, agentResult] = await Promise.all([boundary.classify(hidden), boundary.classify(agent)]);
    expect(hiddenResult).toBe("unsupported");
    expect(agentResult).toBe("agent_run");
    expect(await boundary.grantsImplicitBoard(agent)).toBe(false);
  });
});

describe("connections owned by processes the server cannot inspect", () => {
  const operatorChain = (pid: number) => [
    { pid, ppid: 30, executable: "/opt/browser/browser", environment: new Map<string, string>() },
    { pid: 30, ppid: 1, executable: "/opt/browser/browser", environment: new Map<string, string>() },
  ];
  const agentChain = (pid: number) => [
    { pid, ppid: 40, executable: "/usr/bin/python3", environment: new Map<string, string>() },
    { pid: 40, ppid: 1, executable: "/bin/sh", environment: new Map([["PAPERCLIP_RUN_ID", "run-1"]]) },
  ];

  function boundaryFor(candidates: number[] | null, chains: Record<number, ReturnType<typeof operatorChain>>) {
    const inspector: LocalProcessInspector = {
      async findPeerPids(sockets) {
        return sockets.map(() => candidates ? { candidates } : null);
      },
      async ancestries(pids) {
        return new Map(pids.map((pid) => [pid, chains[pid] ?? null]));
      },
      async ancestorPids(pid) {
        return [pid];
      },
    };
    return createLocalAgentProcessBoundary({ inspector, serverEnvironment: {} });
  }

  const socket = { remoteAddress: "::1", remotePort: 2001, localAddress: "::1", localPort: 3100 };

  it("keeps board access when every uninspectable process belongs to the operator", async () => {
    const boundary = boundaryFor([31, 32], { 31: operatorChain(31), 32: operatorChain(32) });
    expect(await boundary.classify({ ...socket })).toBe("operator");
  });

  it("refuses board access when any uninspectable process belongs to an agent run", async () => {
    const boundary = boundaryFor([31, 41], { 31: operatorChain(31), 41: agentChain(41) });
    expect(await boundary.classify({ ...socket })).toBe("agent_run");
    expect(await boundary.grantsImplicitBoard({ ...socket })).toBe(false);
  });

  it("refuses board access when an uninspectable process has no readable ancestry", async () => {
    expect(await boundaryFor([31, 33], { 31: operatorChain(31) }).classify({ ...socket })).toBe("agent_run");
    expect(await boundaryFor([31, 34], { 31: operatorChain(31), 34: operatorChain(34).slice(0, 1) })
      .classify({ ...socket })).toBe("agent_run");
  });

  it("refuses board access when the connection's owner cannot be found", async () => {
    const boundary = boundaryFor(null, {});
    expect(await boundary.classify({ ...socket })).toBe("agent_run");
  });
});
