import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  ensureRuntimeServicesForRun,
  releaseRuntimeServicesForRun,
  stopRuntimeServicesForExecutionWorkspace,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.js";
import { isPidAlive, listLocalServiceRegistryRecords } from "../services/local-service-supervisor.js";

async function expectListenerClosed(port: number) {
  const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error("Retired listener did not reject a connection"));
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Retired listener still accepts connections"));
    });
    socket.once("error", resolve);
  });
  expect(error.code).toBe("ECONNREFUSED");
}

it("retires an ephemeral runtime and preserves useful files for the same owner's next use", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-lifecycle-"));
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  process.env.PAPERCLIP_HOME = path.join(root, "home");
  process.env.PAPERCLIP_INSTANCE_ID = randomUUID();
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, "retained.txt"), "useful workspace result");
  const script = path.join(cwd, "service.cjs");
  await fs.writeFile(script, `
const fs = require("node:fs");
const http = require("node:http");
const count = fs.existsSync("starts.txt") ? Number(fs.readFileSync("starts.txt", "utf8")) + 1 : 1;
fs.writeFileSync("starts.txt", String(count));
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ pid: process.pid, count, retained: fs.readFileSync("retained.txt", "utf8") }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`);
  const workspace: RealizedExecutionWorkspace = {
    baseCwd: cwd, cwd, source: "project_primary", projectId: randomUUID(), workspaceId: randomUUID(),
    repoUrl: null, repoRef: "HEAD", strategy: "project_primary", branchName: null,
    branchCreatedByRuntime: false, worktreePath: null, warnings: [], created: false,
  };
  const input = {
    agent: { id: randomUUID(), companyId: randomUUID(), name: "Lifecycle worker" },
    issue: null,
    executionWorkspaceId: randomUUID(),
    workspace,
    adapterEnv: {},
    config: { workspaceRuntime: { services: [{
      name: "web", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      port: { type: "auto" },
      readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 100 },
      expose: { type: "url", urlTemplate: "http://127.0.0.1:{{port}}" },
      lifecycle: "ephemeral", reuseScope: "execution_workspace", stopPolicy: { type: "on_run_finish" },
    }] } },
  };
  const runs = [randomUUID(), randomUUID()];
  try {
    const [first] = await ensureRuntimeServicesForRun({ ...input, runId: runs[0]! });
    expect(first).toMatchObject({ reused: false, ownerAgentId: input.agent.id, companyId: input.agent.companyId });
    const firstResult = await (await fetch(first!.url!)).json() as { pid: number; count: number; retained: string };
    expect(firstResult).toMatchObject({ count: 1, retained: "useful workspace result" });
    expect(isPidAlive(firstResult.pid)).toBe(true);
    const firstRecord = (await listLocalServiceRegistryRecords()).find(record => record.runtimeServiceId === first!.id);
    expect(firstRecord).toBeDefined();
    await releaseRuntimeServicesForRun(runs[0]!);
    expect(isPidAlive(firstResult.pid)).toBe(false);
    expect(isPidAlive(firstRecord!.pid)).toBe(false);
    await expectListenerClosed(first!.port!);
    expect((await listLocalServiceRegistryRecords()).filter(record => record.runtimeServiceId === first!.id)).toEqual([]);
    expect(await fs.readFile(path.join(cwd, "retained.txt"), "utf8")).toBe("useful workspace result");

    const [second] = await ensureRuntimeServicesForRun({ ...input, runId: runs[1]! });
    expect(second).toMatchObject({ reused: false, ownerAgentId: input.agent.id, companyId: input.agent.companyId });
    expect(second!.id).not.toBe(first!.id);
    const secondResult = await (await fetch(second!.url!)).json() as { pid: number; count: number; retained: string };
    expect(secondResult).toMatchObject({ count: 2, retained: "useful workspace result" });
    expect(isPidAlive(secondResult.pid)).toBe(true);
    expect(await fs.readFile(path.join(cwd, "starts.txt"), "utf8")).toBe("2");
    await releaseRuntimeServicesForRun(runs[1]!);
    expect(isPidAlive(secondResult.pid)).toBe(false);
    await expectListenerClosed(second!.port!);
    expect((await listLocalServiceRegistryRecords()).filter(record => record.cwd === cwd)).toEqual([]);
  } finally {
    try {
      try {
        for (const run of runs) await releaseRuntimeServicesForRun(run);
      } finally {
        await stopRuntimeServicesForExecutionWorkspace({ executionWorkspaceId: input.executionWorkspaceId, workspaceCwd: cwd });
      }
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
