import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createLocalServiceSandboxLauncher } from "./local-sandbox.js";
import type { RuntimeServiceProviderContext } from "./provider.js";

it.skipIf(process.platform !== "darwin")("enforces the local service network setting in a real child process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-network-"));
  const server = http.createServer((_req, res) => res.end("reachable"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as import("node:net").AddressInfo).port;
    await fs.writeFile(path.join(root, "probe.cjs"), `
      const request = require('node:http').get('http://127.0.0.1:${port}', (response) => {
        response.resume(); response.on('end', () => console.log('connected'));
      });
      request.on('error', (error) => console.log('blocked:' + error.code));
      request.setTimeout(2000, () => { request.destroy(); process.exitCode = 1; });
    `);
    for (const network of ["disabled", "enabled"] as const) {
      const ctx: RuntimeServiceProviderContext = {
        companyId: randomUUID(), serviceId: randomUUID(), allocationId: randomUUID(),
        allocationMetadata: { localBoundary: { kind: "workspace", workspaceRoot: root, network } },
        spec: { command: "node probe.cjs", cwd: root, env: {}, endpoints: [] },
        env: {}, secrets: [], process: { generation: randomUUID() },
      };
      const launch = await createLocalServiceSandboxLauncher()(ctx, { PATH: process.env.PATH! });
      const result = await promisify(execFile)(launch.executable, launch.args, { cwd: root, env: launch.env, timeout: 5000 });
      if (network === "disabled") expect(result.stdout).toMatch(/^blocked:E(?:PERM|ACCES)\n$/);
      else expect(result.stdout).toBe("connected\n");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
