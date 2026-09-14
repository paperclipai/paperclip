import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalRuntimeServiceProvider } from "./local-provider.js";
import { createLocalServiceSandboxLauncher } from "./local-sandbox.js";
import type { RuntimeServiceProviderContext } from "./provider.js";

const support = process.platform === "darwin" || await promisify(execFile)(process.env.PAPERCLIP_SERVICE_SANDBOX_COMMAND ?? "codex", ["sandbox", "--help"], { timeout: 10_000 })
  .then(({ stdout }) => stdout.includes("--permission-profile")).catch(() => false);

describe.skipIf(!support)("local service sandbox with the installed launcher", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  const tempRoots = [...new Set([os.tmpdir(), ...(process.platform === "darwin" ? ["/tmp", "/var/tmp"] : [])])];
  it.each(tempRoots)("serves and hot-reads its workspace under %s without escaping to neighboring files", async (tempRoot) => {
    const root = await fs.mkdtemp(path.join(tempRoot, "paperclip-service-sandbox-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd);
    const outside = path.join(root, "private.txt");
    await fs.writeFile(outside, "outside workspace secret");
    const outsidePaths = [...new Set([outside, await fs.realpath(outside), path.join(cwd, "neighbor-link")])];
    await fs.symlink(outside, path.join(cwd, "neighbor-link"));
    await fs.writeFile(path.join(cwd, "content.txt"), "first edit");
    await fs.writeFile(path.join(cwd, "app.cjs"), `
      const fs = require('node:fs');
      const probe = ${JSON.stringify(`
        const fs = require('node:fs');
        for (const outside of ${JSON.stringify(outsidePaths)}) {
          try { fs.readFileSync(outside); console.log('READ ESCAPED'); } catch { console.log('Read contained'); }
          try { fs.writeFileSync(outside, 'overwritten'); console.log('WRITE ESCAPED'); } catch { console.log('Write contained'); }
        }
      `)};
      eval(probe);
      process.stdout.write(require('node:child_process').execFileSync(process.execPath, ['-e', probe]));
      fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'scratch.txt'), 'service scratch');
      console.log('Workspace scratch writable');
      require('node:http').createServer((q,s) => s.end(fs.readFileSync('content.txt'))).listen(Number(process.env.PORT),'127.0.0.1');
    `);
    const provider = createLocalRuntimeServiceProvider({ root: path.join(root, "supervisors"), prepareLaunch: createLocalServiceSandboxLauncher({ root: path.join(root, "launcher-homes") }) });
    const ctx: RuntimeServiceProviderContext = {
      companyId: randomUUID(), serviceId: randomUUID(), allocationId: randomUUID(),
      allocationMetadata: { localBoundary: { kind: "workspace", workspaceRoot: cwd, network: "enabled" } },
      spec: { command: "node app.cjs", cwd, env: {}, endpoints: [{ name: "web", portEnv: "PORT", healthPath: "/" }] },
      env: {}, secrets: [], process: { generation: randomUUID() },
    };
    cleanups.push(() => provider.stop(ctx));
    ctx.process = await provider.start(ctx);
    let port: number | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      const observation = await provider.inspect(ctx);
      if (observation.endpoints[0]?.healthy) { port = observation.endpoints[0].port; break; }
      if (observation.state === "exited") throw new Error(await provider.logs(ctx, 8192));
      await delay(50);
    }
    if (!port) throw new Error(`Service never became ready: ${await provider.logs(ctx, 8192)}`);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("first edit");
    await fs.writeFile(path.join(cwd, "content.txt"), "continued edit");
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("continued edit");
    expect(await fs.readFile(outside, "utf8")).toBe("outside workspace secret");
    const logs = await provider.logs(ctx, 8192);
    expect(logs).toContain("Read contained");
    expect(logs).toContain("Write contained");
    expect(logs).toContain("Workspace scratch writable");
    expect(logs).not.toContain("ESCAPED");
  });
});
