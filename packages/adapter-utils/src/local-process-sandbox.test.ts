import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLocalProcessSandboxSpawnTarget,
  parseLocalProcessFilesystemScope,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  parseLocalProcessSandboxExtraPaths,
} from "./local-process-sandbox.js";
import { runChildProcess } from "./server-utils.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

describe("local process sandbox", () => {
  it("parses read-only and writable extra paths", () => {
    expect(parseLocalProcessSandboxExtraPaths(["/opt/cache", { path: "/var/lib/tool", access: "rw" }])).toEqual([
      { path: "/opt/cache", access: "ro" },
      { path: "/var/lib/tool", access: "rw" },
    ]);
    expect(() => parseLocalProcessSandboxExtraPaths(["relative"])).toThrow("must be an absolute path");
  });

  it("parses network scopes and exact-host allowlists", () => {
    expect(parseLocalProcessFilesystemScope("workspace")).toBe("workspace");
    expect(parseLocalProcessFilesystemScope(undefined)).toBeNull();
    expect(() => parseLocalProcessFilesystemScope("workpace")).toThrow('filesystemScope must be "workspace"');
    expect(parseLocalProcessNetworkScope("deny")).toBe("deny");
    expect(parseLocalProcessNetworkScope("allowlist")).toBe("allowlist");
    expect(parseLocalProcessNetworkScope(undefined)).toBeNull();
    expect(parseLocalProcessNetworkAllowlist(["api.openai.com", "https://api.anthropic.com", "gateway.test:8443"]))
      .toEqual(["api.openai.com", "api.anthropic.com", "gateway.test:8443"]);
    expect(() => parseLocalProcessNetworkAllowlist(["*.example.com"])).toThrow("exact hostname");
    expect(() => parseLocalProcessNetworkScope("public")).toThrow('"deny" or "allowlist"');
  });

  it("builds a fresh-root bubblewrap command with workspace access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const managedHome = path.join(root, "managed-home");
    await fs.mkdir(workspace);
    await fs.mkdir(managedHome);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        managedPaths: [{ path: managedHome, access: "rw" }],
        homeDir: managedHome,
      },
    });

    expect(target.command).toBe("bwrap");
    expect(target.args).toContain("--tmpfs");
    expect(target.args).toContain(workspace);
    expect(target.args).toContain(managedHome);
    expect(target.args.slice(-3)).toEqual([process.execPath, "-e", "console.log('ok')"]);
  });

  it("builds a network-only namespace without changing filesystem visibility", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-sandbox-"));
    cleanup.push(workspace);
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: workspace,
      options: { workspaceDir: workspace, networkScope: "deny" },
    });

    expect(target.args).toContain("--unshare-net");
    expect(target.args).toContain("--bind");
    expect(target.args).not.toContain("--tmpfs");
    expect(target.env?.HTTP_PROXY).toBeUndefined();
  });

  it("forwards allowed proxy targets and rejects other hosts", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-proxy-"));
    cleanup.push(workspace);
    const server = http.createServer((_request, response) => response.end("allowed-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: [`127.0.0.1:${address.port}`],
      },
    });
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];
    const request = (url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = http.request({ socketPath, path: url, headers: { host: new URL(url).host } }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });

    try {
      await expect(request(`http://127.0.0.1:${address.port}/canary`)).resolves.toEqual({
        status: 200,
        body: "allowed-response",
      });
      await expect(request("http://example.com/")).resolves.toEqual({
        status: 403,
        body: "Network target denied by Paperclip sandbox policy.\n",
      });
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails clearly when Bubblewrap is unavailable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-missing-"));
    cleanup.push(workspace);
    await expect(
      runChildProcess("filesystem-sandbox-missing", process.execPath, ["-e", "process.exit(0)"], {
        cwd: workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          command: path.join(workspace, "missing-bwrap"),
        },
      }),
    ).rejects.toThrow("requires Bubblewrap");
  });

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "prevents reads outside the workspace while allowing workspace writes",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-sandbox-integration-"));
      cleanup.push(root);
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "canary.txt");
      const allowed = path.join(root, "allowed.txt");
      await fs.mkdir(workspace);
      await fs.writeFile(outside, "host-secret", "utf8");
      await fs.writeFile(allowed, "allowed-value", "utf8");

      const script = [
        "const fs = require('node:fs');",
        `try { fs.readFileSync(${JSON.stringify(outside)}, 'utf8'); process.exit(9); } catch (error) {`,
        "  if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;",
        "}",
        `if (fs.readFileSync(${JSON.stringify(allowed)}, 'utf8') !== 'allowed-value') process.exit(8);`,
        "fs.writeFileSync('workspace-ok.txt', 'ok');",
      ].join("\n");
      const result = await runChildProcess("filesystem-sandbox-test", process.execPath, ["-e", script], {
        cwd: workspace,
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          extraPaths: [{ path: allowed, access: "ro" }],
          command: process.env.PAPERCLIP_TEST_BWRAP,
        },
      });

      expect(result.exitCode, result.stderr).toBe(0);
      await expect(fs.readFile(path.join(workspace, "workspace-ok.txt"), "utf8")).resolves.toBe("ok");
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP && process.env.PAPERCLIP_TEST_SANDBOX_BUILD))(
    "runs the adapter-utils TypeScript build inside the confined workspace",
    async () => {
      const workspace = process.cwd();
      const result = await runChildProcess(
        "filesystem-sandbox-build-test",
        path.join(workspace, "node_modules", ".bin", "tsc"),
        ["--noEmit", "-p", "packages/adapter-utils/tsconfig.json"],
        {
          cwd: workspace,
          env: {},
          timeoutSec: 60,
          graceSec: 2,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            filesystemScope: "workspace",
            command: process.env.PAPERCLIP_TEST_BWRAP,
          },
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "denies direct network egress",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-deny-"));
      cleanup.push(workspace);
      const server = http.createServer((_request, response) => response.end("host-network"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
      const script = `require("node:http").get("http://127.0.0.1:${address.port}", () => process.exit(9)).on("error", () => process.exit(0));`;
      try {
        const result = await runChildProcess("network-sandbox-deny-test", process.execPath, ["-e", script], {
          cwd: workspace,
          env: {},
          timeoutSec: 10,
          graceSec: 1,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            networkScope: "deny",
            command: process.env.PAPERCLIP_TEST_BWRAP,
          },
        });
        expect(result.exitCode, result.stderr).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "allows only configured network targets through the proxy bridge",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-allowlist-"));
      cleanup.push(workspace);
      const server = http.createServer((_request, response) => response.end("allowed-response"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
      const targetUrl = `http://127.0.0.1:${address.port}/canary`;
      const deniedUrl = "http://example.com/";
      const script = `
const http = require("node:http");
const proxy = new URL(process.env.HTTP_PROXY);
function request(url) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: proxy.hostname, port: proxy.port, path: url }, (response) => {
      let body = "";
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode, body }));
    }).on("error", reject);
  });
}
(async () => {
  const allowed = await request(${JSON.stringify(targetUrl)});
  const denied = await request(${JSON.stringify(deniedUrl)});
  if (allowed.status !== 200 || allowed.body !== "allowed-response" || denied.status !== 403) process.exit(8);
})().catch((error) => { console.error(error); process.exit(7); });
`;
      try {
        const result = await runChildProcess("network-sandbox-allowlist-test", process.execPath, ["-e", script], {
          cwd: workspace,
          env: {},
          timeoutSec: 10,
          graceSec: 1,
          onLog: async () => {},
          localProcessSandbox: {
            workspaceDir: workspace,
            networkScope: "allowlist",
            networkAllowlist: [`127.0.0.1:${address.port}`],
            command: process.env.PAPERCLIP_TEST_BWRAP,
          },
        });
        expect(result.exitCode, result.stderr).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
