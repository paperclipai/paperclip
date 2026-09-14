import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalRuntimeServiceProvider } from "./local-provider.js";
import type { RuntimeServiceProviderContext } from "./provider.js";

describe.skipIf(process.platform === "win32")("managed local runtime service", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(command: string, secrets: string[] = []) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-v2-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const provider = createLocalRuntimeServiceProvider({ root: path.join(root, "supervisor") });
    const context: RuntimeServiceProviderContext = {
      companyId: randomUUID(), serviceId: randomUUID(), allocationId: randomUUID(), allocationMetadata: {},
      spec: { command, cwd: root, env: {}, endpoints: [{ name: "web", portEnv: "PORT", healthPath: "/" }] },
      env: {}, secrets, process: { generation: randomUUID() },
    };
    cleanups.push(() => provider.stop(context));
    return { root, provider, context };
  }

  async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
    for (let attempt = 0; attempt < 80; attempt++) {
      const value = await read();
      if (accepts(value)) return value;
      await delay(50);
    }
    throw new Error("Service did not reach the expected state");
  }

  it("serves the same files, survives controller replacement, and stops without deleting data", async () => {
    const { root, provider, context } = await setup("node server.cjs");
    await fs.writeFile(path.join(root, "content.txt"), "first version");
    await fs.writeFile(path.join(root, "server.cjs"), `
      const fs = require('node:fs');
      require('node:http').createServer((req, res) => res.end(fs.readFileSync('content.txt'))).listen(Number(process.env.PORT), '127.0.0.1');
    `);
    const ref = await provider.start(context);
    // Simulate the controller dying before it saves the returned ports. Recovery
    // must use the supervisor's receipt rather than start another process.
    const replacement = createLocalRuntimeServiceProvider({ root: path.join(root, "supervisor") });
    const recovered = await replacement.start(context);
    expect(recovered).toEqual(ref);
    const observed = await until(() => replacement.inspect(context), (state) => state.endpoints[0]?.healthy === true);
    const url = `http://127.0.0.1:${observed.endpoints[0].port}`;
    expect(await (await fetch(url)).text()).toBe("first version");
    await fs.writeFile(path.join(root, "content.txt"), "edited by next agent run");
    expect(await (await fetch(url)).text()).toBe("edited by next agent run");
    await replacement.stop(context);
    expect((await replacement.inspect(context)).state).toBe("exited");
    expect(await fs.readFile(path.join(root, "content.txt"), "utf8")).toBe("edited by next agent run");
  });

  it("redacts secrets split across output chunks before storing logs", async () => {
    const secret = "service-test-secret-value";
    const { root, provider, context } = await setup("node output.cjs", [secret]);
    context.spec.endpoints = [];
    await fs.writeFile(path.join(root, "output.cjs"), `
      process.stdout.write('before service-test-');
      setTimeout(() => process.stdout.write('secret-value after\\n'), 50);
      setInterval(() => {}, 1000);
    `);
    context.process = await provider.start(context);
    const logs = await until(() => provider.logs(context, 4096), (output) => output.includes("[REDACTED]"));
    expect(logs).not.toContain(secret);
    const stored = await fs.readFile(path.join(root, "supervisor", context.companyId, context.serviceId, "output.log"), "utf8");
    expect(stored).toContain("before [REDACTED]");
    expect(stored).not.toContain(secret);
  });

  it("does not inherit control-plane credentials into the service", async () => {
    const { root, provider, context } = await setup("node environment.cjs");
    context.spec.endpoints = [];
    const prior = process.env.RUNTIME_SERVICE_TEST_HOST_SECRET;
    process.env.RUNTIME_SERVICE_TEST_HOST_SECRET = "must-stay-in-controller";
    try {
      await fs.writeFile(path.join(root, "environment.cjs"), `
        require('node:fs').writeFileSync('env-result.json', JSON.stringify({ leaked: process.env.RUNTIME_SERVICE_TEST_HOST_SECRET ?? null, configured: process.env.SERVICE_VALUE }));
        setInterval(() => {}, 1000);
      `);
      context.env.SERVICE_VALUE = "explicitly-bound";
      context.process = await provider.start(context);
      const output = await until(async () => fs.readFile(path.join(root, "env-result.json"), "utf8").catch(() => ""), Boolean);
      expect(JSON.parse(output)).toEqual({ leaked: null, configured: "explicitly-bound" });
    } finally {
      if (prior === undefined) delete process.env.RUNTIME_SERVICE_TEST_HOST_SECRET;
      else process.env.RUNTIME_SERVICE_TEST_HOST_SECRET = prior;
    }
  });

  it("fences a stopped generation before a delayed launch arrives", async () => {
    const { root, provider, context } = await setup("node -e 'require(\"node:fs\").writeFileSync(\"should-not-exist\", \"bad\")'");
    await provider.stop(context);
    await expect(provider.start(context)).rejects.toThrow("already exited");
    expect((await provider.inspect(context)).state).toBe("exited");
    await expect(fs.access(path.join(root, "should-not-exist"))).rejects.toThrow();
  });

  it("atomically admits one process when controllers concurrently launch the same generation", async () => {
    const { root, provider, context } = await setup("node once.cjs");
    context.spec.endpoints = [];
    await fs.writeFile(path.join(root, "once.cjs"), `require('node:fs').appendFileSync('launches', 'once\\n'); setInterval(() => {}, 1000);`);
    const other = createLocalRuntimeServiceProvider({ root: path.join(root, "supervisor") });
    const [first, second] = await Promise.all([provider.start(context), other.start(context)]);
    expect(first).toEqual(second);
    await until(() => fs.readFile(path.join(root, "launches"), "utf8").catch(() => ""), Boolean);
    await provider.stop(context);
    expect(await fs.readFile(path.join(root, "launches"), "utf8")).toBe("once\n");
  });
});
