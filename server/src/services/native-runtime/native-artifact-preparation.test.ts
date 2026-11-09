import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createRemoteNativeArtifactPreparation } from "./native-session-executor.js";

type Request = Parameters<CommandManagedRuntimeRunner["execute"]>[0];
const roots: string[] = [];
const metadata = {
  schema: "paperclip-runner/runnerd-build-metadata/v1",
  binaryName: "paperclip-runnerd",
  packageName: "@paperclipai/paperclip-runner",
  binaryContractVersion: 2,
  durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
  prpTransportModes: ["dial_ws_loopback", "dial_wss", "listen_ws"],
};

async function fixture(input: {
  concurrent?: boolean;
  before?: (request: Request) => Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "native-artifact-preparation-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  const cwd = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(cwd);
  const runnerSource = join(bin, "paperclip-runnerd");
  const codexSource = join(bin, "codex");
  const runnerScript = `#!/bin/sh\n[ "$1" = --build-metadata ] || exit 17\nprintf '%s\\n' '${JSON.stringify(metadata)}'\n`;
  await writeFile(runnerSource, runnerScript, { mode: 0o700 });
  await writeFile(codexSource, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.160.0'\n", { mode: 0o700 });
  let active = 0;
  let maxActive = 0;
  const requests: Request[] = [];
  const runner: CommandManagedRuntimeRunner = {
    allowConcurrentSyncOperations: input.concurrent ?? true,
    async execute(request) {
      requests.push(request);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await input.before?.(request);
        return await new Promise((resolve, reject) => {
          const startedAt = new Date().toISOString();
          const child = execFile(request.command, request.args ?? [], {
            cwd: request.cwd ?? cwd,
            env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
            timeout: 10_000,
          }, (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") return reject(error);
            resolve({ exitCode: typeof error?.code === "number" ? error.code : 0,
              signal: error?.signal ?? null, pid: child.pid ?? null, startedAt,
              timedOut: error?.killed === true, stdout, stderr });
          });
          child.stdin?.end(request.stdin);
        });
      } finally {
        active--;
      }
    },
  };
  const runtimeRoot = join(cwd, ".paperclip-runtime");
  const runnerTarget = join(runtimeRoot, "bin", "paperclip-runnerd");
  const codexTarget = join(runtimeRoot, "bin", "codex");
  const options: Parameters<typeof createRemoteNativeArtifactPreparation>[0] = {
    target: { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: cwd, runner },
    runner,
    remoteBinary: runnerTarget,
    controllerRunnerBinary: runnerSource,
    remoteRuntimeRoot: runtimeRoot,
    remoteCodexBinary: codexTarget,
    targetPlatformArtifactVerified: true,
  };
  return { options, requests, runnerSource, runnerTarget, codexSource, codexTarget,
    runnerScript, active: () => active, maxActive: () => maxActive };
}

const discovers = (request: Request, name: string) => request.command === "sh"
  && request.args?.some(value => value.includes(`for candidate in /opt/paperclip-runner/bin/${name} `));

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("remote native artifact preparation", () => {
  it("overlaps the default runner and harness while retaining both executable checks", async () => {
    const f = await fixture();
    await createRemoteNativeArtifactPreparation(f.options).prepare("listen_ws");
    expect(f.maxActive()).toBe(2);
    expect(f.active()).toBe(0);
    expect(await readFile(f.runnerTarget, "utf8")).toBe(f.runnerScript);
    expect(await readFile(f.runnerSource, "utf8")).toBe(f.runnerScript);
    expect(f.requests.filter(request => request.command === f.runnerTarget && request.args?.[0] === "--build-metadata")).toHaveLength(1);
    expect(f.requests.filter(request => request.command === f.codexTarget && request.args?.[0] === "--version")).toHaveLength(1);
    expect(f.requests.some(request => request.command === "npm")).toBe(false);
  });

  it("keeps providers without concurrent sync support serial", async () => {
    const f = await fixture({ concurrent: false });
    await createRemoteNativeArtifactPreparation(f.options).prepare("listen_ws");
    expect(f.maxActive()).toBe(1);
  });

  it("keeps an explicit harness install after runner verification", async () => {
    const f = await fixture();
    await createRemoteNativeArtifactPreparation({ ...f.options, runnerRemoteCodexPath: f.codexSource }).prepare("listen_ws");
    expect(f.maxActive()).toBe(1);
    const verified = f.requests.findIndex(request => request.command === f.runnerTarget);
    const harness = f.requests.findIndex(request => request.command === f.codexTarget);
    expect(verified).toBeGreaterThan(-1);
    expect(harness).toBeGreaterThan(verified);
  });

  it("waits for an admitted harness operation before returning the runner failure", async () => {
    const failure = new Error("runner discovery unavailable");
    let releaseHarness!: () => void;
    const harnessGate = new Promise<void>(resolve => { releaseHarness = resolve; });
    let harnessStarted = false;
    const f = await fixture({ before: async request => {
      if (discovers(request, "paperclip-runnerd")) throw failure;
      if (discovers(request, "codex")) { harnessStarted = true; await harnessGate; }
    } });
    let rejected = false;
    const work = createRemoteNativeArtifactPreparation(f.options).prepare("listen_ws").catch(error => {
      rejected = true;
      return error;
    });
    try {
      await setImmediate();
      expect(harnessStarted).toBe(true);
      expect(rejected).toBe(false);
    } finally {
      releaseHarness();
      expect(await work).toBe(failure);
    }
    expect(f.active()).toBe(0);
    expect(f.requests.some(request => request.command === f.codexTarget)).toBe(true);
  });

  it("preserves the runner failure when both concurrent preparations fail", async () => {
    const runnerFailure = new Error("runner discovery unavailable");
    const harnessFailure = new Error("harness discovery unavailable");
    const f = await fixture({ before: async request => {
      if (discovers(request, "paperclip-runnerd")) throw runnerFailure;
      if (discovers(request, "codex")) throw harnessFailure;
    } });
    await expect(createRemoteNativeArtifactPreparation(f.options).prepare("listen_ws")).rejects.toBe(runnerFailure);
    expect(f.active()).toBe(0);
  });
});
