import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { runtimeServiceRemoteControlSource } from "../src/runtime-service-control.js";
import { runtimeServiceLocalHostSource } from "../src/runtime-service-host.js";

const execute = promisify(execFile);

describe("runtime service controller executable boundary", () => {
  it.each(["file", "symlink"])("ignores a substituted %s at the old helper path", async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-service-controller-"));
    const marker = path.join(root, "substituted-code-ran");
    const helper = path.join(root, `host-${createHash("sha256").update(runtimeServiceLocalHostSource).digest("hex")}.cjs`);
    const malicious = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    if (kind === "file") await writeFile(helper, malicious);
    else {
      const target = path.join(root, "untrusted.cjs");
      await writeFile(target, malicious);
      await symlink(target, helper);
    }
    const input = {
      companyId: randomUUID(), serviceId: randomUUID(), generation: randomUUID(), testRoot: root,
      launch: { command: "sleep 60", cwd: root, env: { TEST_SECRET: "credential-value" }, secretKeys: ["TEST_SECRET"], endpoints: [] },
    };
    async function control(action: string) {
      const result = await execute(process.execPath, ["-e", runtimeServiceRemoteControlSource], {
        env: { ...process.env, PAPERCLIP_SERVICE_CONTROL: JSON.stringify({ ...input, action }) }, timeout: 10_000,
      });
      return JSON.parse(result.stdout);
    }
    try {
      expect(await control("start")).toMatchObject({ state: "running" });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await control("stop");
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("Linux endpoint process group ownership", () => {
  it.each([
    { label: "group leader", pid: 200, parent: 100, group: 200, healthy: true },
    { label: "nested child", pid: 202, parent: 201, group: 200, healthy: true },
    { label: "unrelated group", pid: 300, parent: 200, group: 300, healthy: false },
  ])("handles a listener held by the $label", async ({ pid, parent, group, healthy }) => {
    const input = { action: "inspect", companyId: randomUUID(), serviceId: randomUUID(), generation: randomUUID(), launch: { endpoints: [{ name: "web", healthPath: "/" }] } };
    const stat = (processId: number, ppid: number, pgid: number) => `${processId} (name with spaces) S ${ppid} ${pgid} ${Array(16).fill("0").join(" ")} 123`;
    const fetch = vi.fn(async () => ({ status: 200, body: { cancel: vi.fn() } }));
    const result = await new Promise<string>((resolve, reject) => {
      const files = {
        readFile: async (file: string) => {
          if (file.endsWith(".json")) return JSON.stringify({ state: "running", pid: 100, identity: "123:123", childPid: 200, ports: { web: 8080 } });
          if (file === "/proc/net/tcp") return "header\n0: 00000000:1F90 00000000:0000 0A 0 0 0 0 0 42\n";
          if (file === "/proc/net/tcp6") return "";
          if (file === `/proc/${pid}/stat`) return stat(pid, parent, group);
          if (file === "/proc/100/stat" || file === "/proc/1/stat") return stat(100, 1, 100);
          throw new Error(`Unexpected read: ${file}`);
        },
        readdir: async (file: string) => file === "/proc" ? [String(pid)] : ["7"],
        readlink: async () => "socket:[42]",
      };
      try {
        runInNewContext(runtimeServiceRemoteControlSource, {
          require: (name: string) => {
            if (name === "node:fs/promises") return files;
            if (name === "node:path") return path;
            if (name === "node:crypto") return { randomUUID };
            return {};
          },
          process: { platform: "linux", env: { PAPERCLIP_SERVICE_CONTROL: JSON.stringify(input) }, stdout: { write: resolve } },
          fetch, AbortSignal, setTimeout,
        });
      } catch (error) { reject(error); }
    });
    expect(JSON.parse(result)).toMatchObject({ endpoints: [{ name: "web", port: 8080, healthy }] });
    expect(fetch).toHaveBeenCalledTimes(healthy ? 1 : 0);
  });
});
