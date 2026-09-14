import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeServiceRemoteControlSource } from "@paperclipai/plugin-sdk";

describe.skipIf(process.platform === "win32")("sandbox service control program with real processes", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  async function fixture() {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-service-"));
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
    const input = {
      companyId: randomUUID(), serviceId: randomUUID(), generation: randomUUID(), testRoot: path.join(cwd, "supervisor"),
      launch: { cwd, command: "node app.cjs", endpoints: [{ name: "web", portEnv: "PORT", healthPath: "/" }], env: {} as Record<string, string>, secretKeys: [] as string[] },
      processRef: {} as Record<string, unknown>,
    };
    async function call(action: string) {
      const child = spawn(process.execPath, ["-e", runtimeServiceRemoteControlSource], {
        cwd, env: { PATH: process.env.PATH, PAPERCLIP_SERVICE_CONTROL: JSON.stringify({ ...input, action }) }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { errors += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
      if (code !== 0) throw new Error(`Remote control failed: ${output || errors}`);
      return JSON.parse(output) as { state: string; processRef?: Record<string, unknown>; endpoints: Array<{ name: string; port: number; healthy: boolean }>; logs?: string };
    }
    cleanups.push(async () => { await call("stop"); });
    return { cwd, input, call };
  }
  async function ready(call: (action: string) => Promise<{ endpoints: Array<{ port: number; healthy: boolean }> }>) {
    for (let n = 0; n < 50; n++) {
      const observation = await call("inspect");
      if (observation.endpoints[0]?.healthy) return observation.endpoints[0].port;
      await delay(40);
    }
    throw new Error("Remote service never became ready");
  }

  it("survives the command transport ending and serves the same dirty files on later operations", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, "content.txt"), "original dirty files");
    await fs.writeFile(path.join(f.cwd, "app.cjs"), `require('node:http').createServer((q,s) => s.end(require('node:fs').readFileSync('content.txt'))).listen(Number(process.env.PORT), '0.0.0.0');`);
    const started = await f.call("start");
    f.input.processRef = started.processRef!;
    const port = await ready(f.call);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("original dirty files");
    await fs.writeFile(path.join(f.cwd, "content.txt"), "edited after transport exit");
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("edited after transport exit");
    const repeated = await f.call("start");
    expect(repeated.processRef).toEqual(started.processRef);
    await f.call("stop");
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.cwd, "content.txt"), "utf8")).toBe("edited after transport exit");
  });

  it("keeps service credentials out of the command receipt and saved log", async () => {
    const f = await fixture();
    f.input.launch.env.SERVICE_SECRET = "private-test-credential-value";
    f.input.launch.secretKeys = ["SERVICE_SECRET"];
    f.input.launch.endpoints = [];
    await fs.writeFile(path.join(f.cwd, "app.cjs"), "console.log(process.env.SERVICE_SECRET); setInterval(() => {}, 1000);");
    const result = await f.call("start");
    expect(JSON.stringify(result)).not.toContain(f.input.launch.env.SERVICE_SECRET);
    await delay(150);
    await f.call("stop");
    const logs = await f.call("logs");
    expect(logs.logs).toContain("[REDACTED]");
    expect(logs.logs).not.toContain(f.input.launch.env.SERVICE_SECRET);
  });

  it("does not launch a generation fenced by an earlier stop", async () => {
    const f = await fixture();
    await f.call("stop");
    expect(await f.call("start")).toMatchObject({ state: "exited" });
  });
});
