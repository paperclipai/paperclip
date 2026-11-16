import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { QUALIFIED_ACPX_PROFILES, QUALIFIED_ACPX_VERSION } from "../../vendor/paperclip-runner/index.js";
import { prepareRemoteProviderPackOnTarget, resolveRemoteProviderPackSource, sha256DirectoryTree } from "./native-session-executor.js";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";

const exec = promisify(execFile);
const EXECUTE_LATENCY_MS = 150;
const TRANSFER_LATENCY_MS = 300;
const TRANSFER_BYTES_PER_SECOND = 10 * 1024 * 1024;
const LARGE_ARTIFACT_BYTES = 24 * 1024 * 1024;
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function writePack(root: string, revision: string, large: Buffer, distSuffix = "") {
  const files: Record<string, string | Buffer> = {
    "node_modules/node/bin/node": `#!/bin/sh\nexec '${process.execPath}' "$@"\n`,
    "node_modules/.bin/opencode": "#!/bin/sh\necho 1.18.34\n",
    "node_modules/opencode-ai/bin/opencode.exe": large,
    "node_modules/opencode-ai/package.json": JSON.stringify({ version: "1.18.34" }),
    "node_modules/acpx/package.json": JSON.stringify({ version: QUALIFIED_ACPX_VERSION }),
    "node_modules/@agentclientprotocol/claude-agent-acp/package.json": JSON.stringify({ version: QUALIFIED_ACPX_PROFILES.claude.agentServerVersion }),
    "node_modules/@agentclientprotocol/codex-acp/package.json": JSON.stringify({ version: QUALIFIED_ACPX_PROFILES.codex.agentServerVersion }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "dist/cli/opencode-app-server-proxy.cjs": `module.exports = "proxy${distSuffix}";\n`,
    "dist/cli/acpx-runtime-sidecar.cjs": "module.exports = 'sidecar';\n",
    "dist/providers/grok/launcher.cjs": "module.exports = 'grok';\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await chmod(join(root, "node_modules/node/bin/node"), 0o755);
  await chmod(join(root, "node_modules/.bin/opencode"), 0o755);
  const artifact = (path: string) => ({ path, sha256: sha(files[path]!) });
  const proxy = artifact("dist/cli/opencode-app-server-proxy.cjs"), sidecar = artifact("dist/cli/acpx-runtime-sidecar.cjs");
  const distDigest = sha256DirectoryTree(join(root, "dist"));
  const payload = {
    pins: { nodeMinimum: "24.11.0", codex: QUALIFIED_ACPX_PROFILES.codex.agentRuntimeVersion, opencode: "1.18.34", acpx: QUALIFIED_ACPX_VERSION,
      claudeAcp: QUALIFIED_ACPX_PROFILES.claude.agentServerVersion, codexAcp: QUALIFIED_ACPX_PROFILES.codex.agentServerVersion,
      grok: QUALIFIED_ACPX_PROFILES.grok.agentRuntimeVersion },
    target: { platform: process.platform, architecture: process.arch },
    runnerSourceRevision: revision.repeat(40),
    distDigest,
    bridgeDigest: `sha256:${createHash("sha256").update(proxy.sha256).update("\n").update(sidecar.sha256).update("\n").update(distDigest).digest("hex")}`,
    acpxProfileDigests: { grok: QUALIFIED_ACPX_PROFILES.grok.commandDigest, claude: QUALIFIED_ACPX_PROFILES.claude.commandDigest,
      codex: QUALIFIED_ACPX_PROFILES.codex.commandDigest },
    artifacts: {
      grokLauncher: artifact("dist/providers/grok/launcher.cjs"), nodeCommand: artifact("node_modules/node/bin/node"),
      productionLock: artifact("pnpm-lock.yaml"), opencodeCommand: artifact("node_modules/.bin/opencode"),
      opencodeExecutable: artifact("node_modules/opencode-ai/bin/opencode.exe"), opencodeProxy: proxy, acpxSidecar: sidecar,
    },
  };
  await writeFile(join(root, "provider-pack.json"), JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1",
    digest: sha(canonicalProviderPackJson(payload)), payload }));
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

function assertConfinedSandboxPath(remoteDir: string, candidate: string) {
  const root = posix.normalize(remoteDir);
  const normalized = posix.normalize(candidate);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error(`sync target path escapes the workspace remote dir: ${candidate}`);
  }
}

function simulatedSandbox(home: string, workspace: string) {
  const usage = { simulatedMs: 0, executes: 0, bytesUploaded: 0 };
  const runner: CommandManagedRuntimeRunner = {
    execute: async request => {
      usage.executes += 1;
      usage.simulatedMs += EXECUTE_LATENCY_MS;
      try {
        const result = await exec(request.command, request.args ?? [], { cwd: request.cwd, env: { ...process.env, HOME: home }, maxBuffer: 1 << 24 });
        return { exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { exitCode: typeof failed.code === "number" ? failed.code : 127, signal: null, pid: null, startedAt: null, timedOut: false,
          stdout: failed.stdout ?? "", stderr: failed.stderr ?? String(error) };
      }
    },
    syncIn: async operations => {
      const results = [];
      for (const operation of operations) {
        let bytes = 0;
        for (const file of operation.files) {
          if (file.kind !== "directory" || !file.sourcePath) throw new Error("unexpected transfer");
          assertConfinedSandboxPath(workspace, file.targetPath);
          bytes += await directoryBytes(file.sourcePath);
          await mkdir(dirname(file.targetPath), { recursive: true });
          await cp(file.sourcePath, file.targetPath, { recursive: true });
        }
        usage.bytesUploaded += bytes;
        usage.simulatedMs += TRANSFER_LATENCY_MS + (bytes / TRANSFER_BYTES_PER_SECOND) * 1000;
        results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred: bytes });
      }
      return { operations: results };
    },
  };
  return { runner, usage };
}

type Scenario = "exact" | "same_content_other_build" | "different_content" | "corrupted" | "none";

describe("provider pack selection harness", () => {
  let root: string;
  let large: Buffer;
  let server: ReturnType<typeof resolveRemoteProviderPackSource>;
  const rows: string[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "provider-pack-harness-"));
    large = randomBytes(LARGE_ARTIFACT_BYTES);
    await writePack(join(root, "server-pack"), "b", large);
    server = resolveRemoteProviderPackSource(join(root, "server-pack"));
  });
  afterAll(async () => {
    if (rows.length) process.stdout.write(`\nprovider pack harness (execute ${EXECUTE_LATENCY_MS} ms, transfer ${TRANSFER_LATENCY_MS} ms + ${TRANSFER_BYTES_PER_SECOND / 1024 / 1024} MiB/s)\n${rows.join("\n")}\n`);
    await rm(root, { recursive: true, force: true });
  });

  const run = async (scenario: Scenario, acceptProvenanceDifferences: boolean) => {
    const sandbox = await mkdtemp(join(root, `${scenario}-`));
    const home = join(sandbox, "home"), workspace = join(sandbox, "workspace");
    await mkdir(workspace, { recursive: true });
    const image = join(home, ".local/share/paperclip-runner/provider-pack");
    if (scenario === "exact") await writePack(image, "b", large);
    if (scenario === "same_content_other_build") await writePack(image, "a", large);
    if (scenario === "different_content") await writePack(image, "a", large, "-older");
    if (scenario === "corrupted") {
      await writePack(image, "a", large);
      await writeFile(join(image, "dist/cli/acpx-runtime-sidecar.cjs"), "tampered\n");
    }
    const { runner, usage } = simulatedSandbox(home, workspace);
    const cpuBefore = process.cpuUsage();
    const startedAt = performance.now();
    const prepared = await prepareRemoteProviderPackOnTarget({
      target: { kind: "remote", transport: "sandbox", remoteCwd: workspace, runner } as never,
      runner, configuredProviderPackRoot: server.configuredRoot, manifest: server.manifest, acceptProvenanceDifferences,
    });
    const wallMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    rows.push(`${scenario.padEnd(26)} ${acceptProvenanceDifferences ? "after " : "before"} source=${prepared.source.padEnd(12)} `
      + `modelled=${((wallMs + usage.simulatedMs) / 1000).toFixed(2)}s uploaded=${(usage.bytesUploaded / 1024 / 1024).toFixed(1)}MiB `
      + `executes=${usage.executes} serverCpu=${((cpu.user + cpu.system) / 1000).toFixed(0)}ms dbStatements=0`);
    return { prepared, usage };
  };

  it("confines simulated uploads to the workspace", async () => {
    const { runner } = simulatedSandbox(root, join(root, "workspace"));
    await expect(runner.syncIn!([{ operationId: "escape", files: [{ kind: "directory", sourcePath: join(root, "server-pack"),
      targetPath: join(root, "workspace", "..", "outside"), mode: 0o700 }] }])).rejects.toThrow("escapes the workspace");
  });

  it.each<[Scenario, "preinstalled" | "uploaded", "preinstalled" | "uploaded"]>([
    ["exact", "preinstalled", "preinstalled"],
    ["same_content_other_build", "uploaded", "preinstalled"],
    ["different_content", "uploaded", "uploaded"],
    ["corrupted", "uploaded", "uploaded"],
    ["none", "uploaded", "uploaded"],
  ])("selects the pack for %s (before: %s, after: %s)", async (scenario, before, after) => {
    const previous = await run(scenario, false);
    expect(previous.prepared.source).toBe(before);
    expect(previous.prepared.manifest).toEqual(server.manifest);
    const current = await run(scenario, true);
    expect(current.prepared.source).toBe(after);
    expect(current.usage.bytesUploaded).toBe(after === "uploaded" ? previous.usage.bytesUploaded : 0);
    if (scenario === "same_content_other_build") {
      expect(current.prepared.manifest.digest).not.toBe(server.manifest.digest);
      expect(current.prepared.manifest.payload.runnerSourceRevision).toBe("a".repeat(40));
      expect({ ...current.prepared.manifest.payload, runnerSourceRevision: null })
        .toEqual({ ...server.manifest.payload, runnerSourceRevision: null });
    } else {
      expect(current.prepared.manifest).toEqual(server.manifest);
    }
  }, 120_000);
});
