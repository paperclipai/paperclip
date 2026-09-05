import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxManagedRuntimeAsset } from "@paperclipai/adapter-utils/sandbox-managed-runtime";

// Captured Codex `home` asset descriptor + the sandbox `auth.json` fixture the
// mocked runtime hands back during teardown. Mutated per-test so a single
// harness drives every round-trip case through the REAL `execute()` wiring.
const captured: { assets: SandboxManagedRuntimeAsset[] } = { assets: [] };
const sandboxAuthFixture: { bytes: Buffer } = { bytes: Buffer.from("{}") };
const REMOTE_RUNTIME_ROOT = "/remote/workspace/.paperclip-runtime/codex";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
  assertManagedCredentialHome,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
  // Wraps the real `assertManagedCredentialHome` by default (set below, once
  // the actual module is available); a test overrides it for one call with
  // `mockRejectedValueOnce` to simulate an operational guard failure.
  assertManagedCredentialHome: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

vi.mock("@paperclipai/adapter-utils/managed-credential-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/managed-credential-home")>();
  // Default implementation is the real guard; a test overrides it once with
  // `assertManagedCredentialHome.mockRejectedValueOnce(...)`.
  assertManagedCredentialHome.mockImplementation(actual.assertManagedCredentialHome);
  return {
    ...actual,
    assertManagedCredentialHome,
  };
});

import { execute } from "./execute.js";

// Mirror the sandbox core's restore closure: capture the assets `execute()`
// declares, then during teardown invoke each asset's `restore` with an injected
// `readFile` (returns the sandbox fixture) and the remote asset dir. This drives
// the exact `restore` contribution the Codex adapter wires in production without
// needing a live sandbox.
prepareAdapterExecutionTargetRuntime.mockImplementation(async (input: { assets?: SandboxManagedRuntimeAsset[] }) => {
  captured.assets = input.assets ?? [];
  return {
    target: { kind: "remote", transport: "ssh" },
    workspaceRemoteDir: "/remote/workspace",
    runtimeRootDir: REMOTE_RUNTIME_ROOT,
    assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
    restoreWorkspace: async () => {
      for (const asset of captured.assets) {
        if (!asset.restore) continue;
        await asset.restore({
          assetDir: `${REMOTE_RUNTIME_ROOT}/home`,
          readFile: async () => sandboxAuthFixture.bytes,
        });
      }
    },
  };
});

const COPYBACK_COMPANY_ID = "company-1";

describe("codex execute — outbound auth copy-back restore contribution", () => {
  const cleanupDirs: string[] = [];
  let savedCodexHomeEnv: string | undefined;
  let savedPaperclipHomeEnv: string | undefined;
  let savedPaperclipInstanceIdEnv: string | undefined;

  afterEach(async () => {
    vi.clearAllMocks();
    if (savedCodexHomeEnv === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = savedCodexHomeEnv;
    }
    if (savedPaperclipHomeEnv === undefined) {
      delete process.env.PAPERCLIP_HOME;
    } else {
      process.env.PAPERCLIP_HOME = savedPaperclipHomeEnv;
    }
    if (savedPaperclipInstanceIdEnv === undefined) {
      delete process.env.PAPERCLIP_INSTANCE_ID;
    } else {
      process.env.PAPERCLIP_INSTANCE_ID = savedPaperclipInstanceIdEnv;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function subscriptionAuth(input: { accountId: string; lastRefresh?: string; marker: string }): string {
    return JSON.stringify(
      {
        tokens: {
          id_token: `id-token-${input.marker}`,
          access_token: `access-token-${input.marker}`,
          refresh_token: `refresh-token-${input.marker}`,
          account_id: input.accountId,
        },
        ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
      },
      null,
      2,
    );
  }

  async function runTeardown(input: {
    sandboxAuth: string;
    hostAuth: string;
  }): Promise<{ finalHostAuth: string; finalHostMode: number; logs: string[] }> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-copyback-e2e-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    // The copy-back guard requires its target to sit under the Paperclip-
    // managed company tree (`<PAPERCLIP_HOME>/instances/<instanceId>/companies/<id>`),
    // so this points PAPERCLIP_HOME at a tmp dir and places the shared host home
    // — what `resolveSharedCodexHomeDir` returns via process.env.CODEX_HOME, and
    // the copy-back target — inside that company's managed tree. The round-trip
    // never touches the real host credential. `PAPERCLIP_INSTANCE_ID` is pinned
    // to the literal "default" segment used below: the guard reads that env var
    // and falls back to "default" only when it is UNSET, so a suite runner that
    // sets it ambiently (for its own test isolation) would otherwise point the
    // guard's boundary at an instance directory this test never creates.
    const paperclipHome = path.join(rootDir, "paperclip-home");
    const companyDir = path.join(paperclipHome, "instances", "default", "companies", COPYBACK_COMPANY_ID);
    const sharedHostHome = path.join(companyDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sharedHostHome, { recursive: true });
    const hostAuthPath = path.join(sharedHostHome, "auth.json");
    await writeFile(hostAuthPath, input.hostAuth, { mode: 0o600 });

    savedCodexHomeEnv = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sharedHostHome;
    savedPaperclipHomeEnv = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = paperclipHome;
    savedPaperclipInstanceIdEnv = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    sandboxAuthFixture.bytes = Buffer.from(input.sandboxAuth, "utf8");

    const logs: string[] = [];

    await execute({
      runId: "run-copyback-e2e",
      agent: {
        id: "agent-1",
        companyId: COPYBACK_COMPANY_ID,
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        engine: "cli",
        // A configured CODEX_HOME equal to process.env.CODEX_HOME (the shared
        // source `resolveSharedCodexHomeDir` reads) makes managed seeding a
        // self-copy no-op, so it never rewrites auth.json before teardown.
        env: { CODEX_HOME: sharedHostHome },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async (_stream, line) => {
        logs.push(line);
      },
    });

    return {
      finalHostAuth: await readFile(hostAuthPath, "utf8"),
      finalHostMode: (await lstat(hostAuthPath)).mode & 0o777,
      logs,
    };
  }

  it("declares a Codex `home` asset carrying both inbound provision and outbound restore contributions", async () => {
    await runTeardown({
      sandboxAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "2026-07-09T01:00:00Z", marker: "s" }),
      hostAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "2026-07-09T02:00:00Z", marker: "h" }),
    });

    const homeAsset = captured.assets.find((asset) => asset.key === "home");
    expect(homeAsset).toBeDefined();
    expect(homeAsset?.provision).toBeTruthy();
    expect(typeof homeAsset?.restore).toBe("function");
  });

  it("round-trips a strictly-newer same-identity sandbox auth.json to the shared host at 0600 on teardown", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T02:00:00Z",
      marker: "sandbox-newer",
    });
    const hostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T01:00:00Z",
      marker: "host-older",
    });

    const result = await runTeardown({ sandboxAuth, hostAuth });

    expect(result.finalHostAuth).toBe(sandboxAuth);
    expect(result.finalHostMode).toBe(0o600);
  });

  it("keeps the host auth.json when the sandbox copy is a tie or older on teardown", async () => {
    const cases = [
      {
        name: "tie",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "s-tie" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "h-tie" }),
      },
      {
        name: "older",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T01:00:00Z", marker: "s-old" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "h-new" }),
      },
    ];

    for (const entry of cases) {
      const result = await runTeardown({ sandboxAuth: entry.sandboxAuth, hostAuth: entry.hostAuth });
      expect(result.finalHostAuth, entry.name).toBe(entry.hostAuth);
      expect(result.finalHostMode, entry.name).toBe(0o600);
    }
  });

  it("surfaces the real error instead of a misleading containment message when the managed-home guard fails operationally", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-op-error",
      lastRefresh: "2026-07-09T02:00:00Z",
      marker: "sandbox",
    });
    const hostAuth = subscriptionAuth({
      accountId: "acct-op-error",
      lastRefresh: "2026-07-09T01:00:00Z",
      marker: "host",
    });

    // A permission fault, an I/O error, or a symlink loop reading the guard's
    // own directory tree is not a containment rejection: the copy-back must
    // not treat it as benign "outside the managed tree" and must not silently
    // keep the (stale) host credential without saying why.
    const operationalError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    assertManagedCredentialHome.mockRejectedValueOnce(operationalError);

    const result = await runTeardown({ sandboxAuth, hostAuth });

    expect(result.finalHostAuth).toBe(hostAuth);
    expect(result.logs.some((line) => line.includes("EACCES: permission denied"))).toBe(true);
    expect(result.logs.some((line) => line.includes("outside the managed directory tree"))).toBe(false);
  });
});
