import { execFile } from "node:child_process";
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
  type LocalProcessInspector,
  findPeerPidInDarwinNetstat,
  findSocketInodeInProcNet,
} from "../middleware/local-agent-process-boundary.js";

const supported = process.platform === "linux" || process.platform === "darwin";

function startServer(serverEnvironment: NodeJS.ProcessEnv): Promise<{ server: Server; url: string }> {
  const app = express();
  app.use(actorMiddleware({} as Db, {
    deploymentMode: "local_trusted",
    localAgentProcessBoundary: createLocalAgentProcessBoundary({ serverEnvironment }),
  }));
  app.get("/api/whoami", (req, res) => {
    res.json({ type: req.actor.type, source: req.actor.source ?? null });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/api/whoami` });
    });
  });
}

const fetchScript = "fetch(process.argv[1]).then(r => r.text()).then(t => process.stdout.write(t))";

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ type: string; source: string | null }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(JSON.parse(stdout));
    });
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

describe("local process identification", () => {
  it("finds the client socket inode in a Linux TCP table", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0C1C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0",
      "   1: 0100007F:D431 0100007F:0C1C 01 00000000:00000000 00:00000000 00000000  1000        0 222 1 0 20 4 30 10 -1",
      "   2: 0100007F:0C1C 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0 20 4 30 10 -1",
    ].join("\n");
    expect(findSocketInodeInProcNet(table, { address: "127.0.0.1", port: 54321 }, { address: "127.0.0.1", port: 3100 }))
      .toBe("222");
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
