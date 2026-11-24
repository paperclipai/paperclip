import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalProcessSandboxSpawnTarget,
  parseLocalProcessFilesystemScope,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  parseLocalProcessSandboxExtraPaths,
  resolveRunScratchSandboxMount,
} from "./local-process-sandbox.js";
import { runChildProcess } from "./server-utils.js";

const cleanup: string[] = [];

async function withTmpDir<T>(tmpDir: string, run: () => Promise<T>): Promise<T> {
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = tmpDir;
  try {
    return await run();
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

describe("local process sandbox", () => {
  it.runIf(process.platform !== "linux")("rejects sandbox scopes on unsupported hosts", async () => {
    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(),
      options: { workspaceDir: process.cwd(), networkScope: "deny" },
    })).rejects.toThrow("supported only on Linux");
  });

  describe("run scratch sandbox mount", () => {
    async function makeScratchRoot() {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-scratch-home-"));
      cleanup.push(home);
      const root = path.join(home, ".pctmp");
      const scratch = path.join(root, "abcd1234");
      await fs.mkdir(scratch, { recursive: true });
      return { home, scratch };
    }

    async function writeMarker(scratch: string, runId: string) {
      await fs.writeFile(
        path.join(scratch, ".paperclip-run-scratch.json"),
        JSON.stringify({ version: 1, companyId: "c", agentId: "a", runId, issueId: null, issueIdentifier: null, createdAt: new Date().toISOString() }),
      );
    }

    it("mounts the run's own marked scratch directory read-write", async () => {
      const { home, scratch } = await makeScratchRoot();
      await writeMarker(scratch, "run-1");
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_RUN_ID: "run-1" },
        { homeDir: home },
      )).resolves.toEqual({ path: scratch, access: "rw" });
    });

    it("mounts a collision-fallback scratch directory whose mkdtemp suffix has uppercase letters", async () => {
      // prepareHeartbeatRunScratch falls back to `mkdtemp(root, "<segment>-")`
      // when two runs share the first eight run id characters, and mkdtemp
      // suffixes draw from both letter cases.
      const { home } = await makeScratchRoot();
      const fallback = path.join(home, ".pctmp", "abcd1234-fWJEH1");
      await fs.mkdir(fallback);
      await writeMarker(fallback, "run-1");
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: fallback, PAPERCLIP_RUN_ID: "run-1" },
        { homeDir: home },
      )).resolves.toEqual({ path: fallback, access: "rw" });
    });

    it("rejects a marker swapped to a symlink after lstat", async () => {
      const { home, scratch } = await makeScratchRoot();
      await writeMarker(scratch, "run-1");
      const marker = path.join(scratch, ".paperclip-run-scratch.json");
      const outside = path.join(home, "outside.json");
      await fs.copyFile(marker, outside);
      const lstat = fs.lstat.bind(fs);
      let swapped = false;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const stats = await lstat(...args);
        if (String(args[0]) === marker && !swapped) {
          await fs.unlink(marker); await fs.symlink(outside, marker); swapped = true;
        }
        return stats;
      });
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_RUN_ID: "run-1" }, { homeDir: home },
      )).resolves.toBeNull();
      expect(swapped).toBe(true);
      expect(JSON.parse(await fs.readFile(outside, "utf8")).runId).toBe("run-1");
    });

    it("rejects a valid JSON marker padded beyond the evidence limit", async () => {
      const { home, scratch } = await makeScratchRoot();
      await writeMarker(scratch, "run-1");
      await fs.appendFile(path.join(scratch, ".paperclip-run-scratch.json"), " ".repeat(16 * 1024));
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_RUN_ID: "run-1" }, { homeDir: home },
      )).resolves.toBeNull();
    });

    it("rejects a regular replacement with a different inode after lstat", async () => {
      const { home, scratch } = await makeScratchRoot();
      await writeMarker(scratch, "run-1");
      const marker = path.join(scratch, ".paperclip-run-scratch.json");
      const replacement = path.join(home, "replacement.json");
      await fs.copyFile(marker, replacement);
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementationOnce(async (...args: Parameters<typeof fs.lstat>) => {
        const stats = await lstat(...args);
        await fs.rename(replacement, marker);
        return stats;
      });
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_RUN_ID: "run-1" }, { homeDir: home },
      )).resolves.toBeNull();
    });

    it.runIf(process.platform !== "win32")("rejects a FIFO replacement without blocking the open", async () => {
      const { home, scratch } = await makeScratchRoot();
      await writeMarker(scratch, "run-1");
      const marker = path.join(scratch, ".paperclip-run-scratch.json");
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementationOnce(async (...args: Parameters<typeof fs.lstat>) => {
        const stats = await lstat(...args);
        await fs.unlink(marker); execFileSync("mkfifo", [marker]);
        return stats;
      });
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_RUN_ID: "run-1" }, { homeDir: home },
      )).resolves.toBeNull();
    });

    it("bounds a marker that grows after fstat and closes its handle", async () => {
      const { home, scratch } = await makeScratchRoot();
      await writeMarker(scratch, "run-1");
      const marker = path.join(scratch, ".paperclip-run-scratch.json");
      const open = fs.open.bind(fs);
      let close: ReturnType<typeof vi.spyOn> | undefined;
      let grew = false;
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        const stat = handle.stat.bind(handle);
        close = vi.spyOn(handle, "close");
        vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
          const stats = await stat();
          await fs.appendFile(marker, " ".repeat(16 * 1024)); grew = true;
          return stats;
        });
        return handle;
      });
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_RUN_ID: "run-1" }, { homeDir: home },
      )).resolves.toBeNull();
      expect(grew).toBe(true);
      expect(close).toHaveBeenCalledOnce();
    });

    it("mounts nothing without a run identity, a scratch value, or a marker", async () => {
      const { home, scratch } = await makeScratchRoot();
      await writeMarker(scratch, "run-1");
      const overrides = { homeDir: home };
      await expect(resolveRunScratchSandboxMount({ PAPERCLIP_RUN_ID: "run-1" }, overrides)).resolves.toBeNull();
      await expect(resolveRunScratchSandboxMount({ PAPERCLIP_RUN_SCRATCH_DIR: scratch }, overrides)).resolves.toBeNull();
      // No marker at all.
      const bare = path.join(home, ".pctmp", "bare00000");
      await fs.mkdir(bare);
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: bare, PAPERCLIP_RUN_ID: "run-1" }, overrides,
      )).resolves.toBeNull();
    });

    it("mounts nothing for a directory marked for a different run", async () => {
      const { home, scratch } = await makeScratchRoot();
      await writeMarker(scratch, "someone-else");
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_RUN_ID: "run-1" },
        { homeDir: home },
      )).resolves.toBeNull();
    });

    it("mounts nothing outside the instance run temp root or with a malformed segment", async () => {
      const { home, scratch } = await makeScratchRoot();
      await writeMarker(scratch, "run-1");
      const env = { PAPERCLIP_RUN_SCRATCH_DIR: scratch, PAPERCLIP_RUN_ID: "run-1" };
      // The scratch exists, but under a different instance's home.
      const otherHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-scratch-other-"));
      cleanup.push(otherHome);
      await expect(resolveRunScratchSandboxMount(env, { homeDir: otherHome })).resolves.toBeNull();
      // A segment the run temp root would never create.
      const odd = path.join(home, ".pctmp", "Not A Segment");
      await fs.mkdir(odd);
      await writeMarker(odd, "run-1");
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: odd, PAPERCLIP_RUN_ID: "run-1" }, { homeDir: home },
      )).resolves.toBeNull();
      // Uppercase never starts a segment: only mkdtemp suffixes carry it.
      const upperFirst = path.join(home, ".pctmp", "Abcd1234");
      await fs.mkdir(upperFirst);
      await writeMarker(upperFirst, "run-1");
      await expect(resolveRunScratchSandboxMount(
        { PAPERCLIP_RUN_SCRATCH_DIR: upperFirst, PAPERCLIP_RUN_ID: "run-1" }, { homeDir: home },
      )).resolves.toBeNull();
      // Relative values never mount.
      await expect(resolveRunScratchSandboxMount({ PAPERCLIP_RUN_SCRATCH_DIR: "relative", PAPERCLIP_RUN_ID: "run-1" }, { homeDir: home }))
        .resolves.toBeNull();
    });
  });

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

  it.runIf(process.platform === "linux")("describes every valid allowlist input when no proxy rules remain", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-rules-"));
    cleanup.push(workspace);

    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        networkScope: "allowlist",
        networkAllowlist: [],
        networkTrustedUrls: ["file:///not-a-network-target"],
      },
    })).rejects.toThrow("valid networkAllowlist hostname or HTTP(S) networkTrustedUrl");
  });

  it.runIf(process.platform === "linux")("builds a fresh-root bubblewrap command with workspace access", async () => {
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

  it.runIf(process.platform === "linux")("binds a confined absolute alias to the synchronized workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-alias-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);

    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        pathAliases: [{ path: "/app", target: workspace }],
      },
    });

    expect(target.args).toEqual(expect.arrayContaining(["--bind", workspace, "/app"]));
  });

  it.runIf(process.platform === "linux")("rejects writable out-of-tree paths without an outbound restore mapping", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-outbound-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);

    await expect(buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      options: {
        workspaceDir: workspace,
        filesystemScope: "workspace",
        extraPaths: [{ path: outside, access: "rw" }],
      },
    })).rejects.toThrow("has no outbound restore mapping");
  });

  it.runIf(process.platform === "linux")("builds a network-only namespace without changing filesystem visibility", async () => {
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

  it.runIf(process.platform === "linux")("forwards allowed proxy targets with a deep TMPDIR and rejects other hosts", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-proxy-"));
    cleanup.push(workspace);
    const deepTmpDir = path.join(workspace, ...Array.from({ length: 6 }, () => "deep-temporary-directory-segment"));
    await fs.mkdir(deepTmpDir, { recursive: true });
    const server = http.createServer((_request, response) => response.end("allowed-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
    const target = await withTmpDir(deepTmpDir, () =>
      buildLocalProcessSandboxSpawnTarget({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        options: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          networkScope: "allowlist",
          networkAllowlist: [`127.0.0.1:${address.port}`],
        },
      }),
    );
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];
    expect(Buffer.byteLength(path.join(deepTmpDir, "paperclip-network-sandbox-XXXXXX", "proxy.sock"))).toBeGreaterThan(107);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(107);
    expect(socketPath).toMatch(/^\/tmp\/paperclip-network-sandbox-/);
    expect(target.args).toContain(path.dirname(socketPath));
    const request = (url: string) => new Promise<{ status: number; contentType: string | null; body: string }>((resolve, reject) => {
      const outgoing = http.request({ socketPath, path: url, headers: { host: new URL(url).host } }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null,
          body,
        }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });

    try {
      await expect(request(`http://127.0.0.1:${address.port}/canary`)).resolves.toEqual({
        status: 200,
        contentType: null,
        body: "allowed-response",
      });
      await expect(request("http://example.com/")).resolves.toEqual({
        status: 403,
        contentType: "application/json; charset=utf-8",
        body: '{"error":{"code":"network_target_denied","message":"Network target denied by Paperclip sandbox policy."}}\n',
      });
      const connectResponse = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.end("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        });
        let response = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => { response += chunk; });
        socket.on("end", () => resolve(response));
        socket.on("error", reject);
      });
      expect(connectResponse).toContain("HTTP/1.1 403 Forbidden\r\n");
      expect(connectResponse).toContain("Content-Type: application/json; charset=utf-8\r\n");
      expect(connectResponse).toContain(
        '{"error":{"code":"network_target_denied","message":"Network target denied by Paperclip sandbox policy."}}\n',
      );
    } finally {
      await target.cleanup?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.runIf(process.platform === "linux")("always permits trusted Paperclip control-plane URLs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-network-trusted-"));
    cleanup.push(workspace);
    const server = http.createServer((_request, response) => response.end("control-plane-response"));
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
        networkAllowlist: ["api.openai.com"],
        networkTrustedUrls: [`http://127.0.0.1:${address.port}/api/issues/issue-1`],
      },
    });
    const delimiterIndex = target.args.indexOf("--");
    const socketPath = target.args[delimiterIndex + 3];

    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = http.request({
          socketPath,
          path: `http://127.0.0.1:${address.port}/api/issues/issue-1`,
          headers: { host: `127.0.0.1:${address.port}` },
        }, (incoming) => {
          let body = "";
          incoming.on("data", (chunk) => { body += chunk; });
          incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
      expect(response).toEqual({ status: 200, body: "control-plane-response" });
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
    "binds the run's marked scratch directory so TMPDIR stays usable and host-backed",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-scratch-bind-"));
      cleanup.push(workspace);
      // The validation reads the real home's run temp root.
      const segment = `s1${Date.now().toString(36).slice(-6)}`;
      const scratch = path.join(os.homedir(), ".pctmp", segment);
      await fs.mkdir(scratch, { recursive: true });
      cleanup.push(scratch);
      await fs.writeFile(
        path.join(scratch, ".paperclip-run-scratch.json"),
        JSON.stringify({ version: 1, companyId: "c", agentId: "a", runId: "run-bind", issueId: null, issueIdentifier: null, createdAt: new Date().toISOString() }),
      );
      const target = JSON.stringify(path.join(scratch, "confined-write.txt"));

      const script = [
        "const fs = require('node:fs');",
        `if (!fs.statSync(process.env.TMPDIR).isDirectory()) process.exit(9);`,
        `fs.writeFileSync(${target}, 'host-backing');`,
        `if (fs.readFileSync(${target}, 'utf8') !== 'host-backing') process.exit(8);`,
      ].join("\n");
      const result = await runChildProcess("filesystem-scratch-bind-test", process.execPath, ["-e", script], {
        cwd: workspace,
        env: {
          TMPDIR: scratch,
          PAPERCLIP_RUN_SCRATCH_DIR: scratch,
          PAPERCLIP_RUN_ID: "run-bind",
        },
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          command: process.env.PAPERCLIP_TEST_BWRAP,
        },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      // The write reached the host directory, not a volatile sandbox tmpfs.
      await expect(fs.readFile(path.join(scratch, "confined-write.txt"), "utf8")).resolves.toBe("host-backing");
    },
  );

  it.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))(
    "mounts nothing when the scratch directory belongs to a different run",
    async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-scratch-foreign-"));
      cleanup.push(workspace);
      const segment = `s2${Date.now().toString(36).slice(-6)}`;
      const scratch = path.join(os.homedir(), ".pctmp", segment);
      await fs.mkdir(scratch, { recursive: true });
      cleanup.push(scratch);
      await fs.writeFile(
        path.join(scratch, ".paperclip-run-scratch.json"),
        JSON.stringify({ version: 1, companyId: "c", agentId: "a", runId: "someone-else", issueId: null, issueIdentifier: null, createdAt: new Date().toISOString() }),
      );

      const script = [
        "const fs = require('node:fs');",
        `try { fs.statSync(process.env.TMPDIR); process.exit(9); } catch (error) {`,
        "  if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;",
        "}",
      ].join("\n");
      const result = await runChildProcess("filesystem-scratch-foreign-test", process.execPath, ["-e", script], {
        cwd: workspace,
        env: {
          TMPDIR: scratch,
          PAPERCLIP_RUN_SCRATCH_DIR: scratch,
          PAPERCLIP_RUN_ID: "run-bind",
        },
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        localProcessSandbox: {
          workspaceDir: workspace,
          filesystemScope: "workspace",
          command: process.env.PAPERCLIP_TEST_BWRAP,
        },
      });
      expect(result.exitCode, result.stderr).toBe(0);
    },
  );

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
        const deepTmpDir = path.join(workspace, ...Array.from({ length: 6 }, () => "deep-temporary-directory-segment"));
        await fs.mkdir(deepTmpDir, { recursive: true });
        const result = await withTmpDir(deepTmpDir, () =>
          runChildProcess(
            "network-sandbox-allowlist-test",
            process.execPath,
            ["-e", script],
            {
              cwd: workspace,
              env: {},
              timeoutSec: 10,
              graceSec: 1,
              onLog: async () => {},
              localProcessSandbox: {
                workspaceDir: workspace,
                filesystemScope: "workspace",
                networkScope: "allowlist",
                networkAllowlist: [`127.0.0.1:${address.port}`],
                command: process.env.PAPERCLIP_TEST_BWRAP,
              },
            },
          ),
        );
        expect(result.exitCode, result.stderr).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
