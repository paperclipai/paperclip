import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeProviderArtifactSource } from "./native-provider-artifacts.js";
import { captureRemoteNativeProviderArtifacts } from "./native-provider-artifact-capture.js";

const run = promisify(execFile);

// Mirrors the Daytona provider's outbound source guard (`assertConfinedSandboxPath`
// in packages/plugins/sandbox-providers/daytona/src/file-sync.ts). Kubernetes and
// CreateOS apply the same workspace-root confinement to export sources.
function assertConfinedSandboxPath(remoteDir: string, candidate: string, label: string) {
  const root = posix.normalize(remoteDir);
  const normalized = posix.normalize(candidate);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error(`Daytona sync ${label} path escapes the workspace remote dir: ${candidate}`);
  }
}
const names = ["nodeCommand", "opencodeProxy", "opencodeExecutable"] as const;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A sandbox whose bulk export is confined to the workspace remote dir, as the
 * Daytona, Kubernetes, and CreateOS providers are. The qualified launch root
 * lives under the sandbox account's home, outside that workspace.
 */
async function confinedSandbox() {
  const sandbox = await mkdtemp(join(tmpdir(), "pc-confined-sandbox-"));
  roots.push(sandbox);
  const home = join(sandbox, "home", "daytona");
  const remoteCwd = join(home, "workspace");
  await mkdir(remoteCwd, { recursive: true });
  const launchRoot = join(home, ".paperclip-runtime", "paperclip-runner", "provider-artifacts", "dfe9e4b1d660");
  const artifacts: Record<string, { path: string; sha256: string }> = {};
  const paths = {} as Record<(typeof names)[number], string>;
  for (const name of names) {
    const relative = `bin/${name}`;
    const bytes = `qualified ${name} bytes`;
    await mkdir(join(launchRoot, "bin"), { recursive: true });
    await writeFile(join(launchRoot, relative), bytes, { mode: 0o500 });
    artifacts[name] = { path: relative, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
    paths[name] = join(launchRoot, relative);
  }
  const syncOut = vi.fn<NonNullable<CommandManagedRuntimeRunner["syncOut"]>>(async (operations) => {
    for (const operation of operations) {
      for (const file of operation.files) {
        assertConfinedSandboxPath(remoteCwd, file.sourcePath, "source");
        await copyFile(file.sourcePath, file.targetPath);
      }
    }
    return { operations: [] };
  });
  const runner = {
    execute: vi.fn(async (input: { command: string; args?: string[] }) => {
      try {
        const result = await run(input.command, input.args ?? []);
        return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.code ?? 1, signal: null, timedOut: false, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
    }),
    syncOut,
  } as unknown as CommandManagedRuntimeRunner;
  const manifest = { digest: `sha256:${"d".repeat(64)}`, payload: { artifacts } } as unknown as NativeProviderArtifactSource["manifest"];
  return { remoteCwd, launchRoot, paths, runner, syncOut, manifest };
}

it("exports qualified launch files that live outside the workspace through a confined staging copy", async () => {
  const sandbox = await confinedSandbox();
  const published: Record<string, string> = {};
  const result = await captureRemoteNativeProviderArtifacts(
    {
      runner: sandbox.runner,
      remoteCwd: sandbox.remoteCwd,
      manifest: sandbox.manifest,
      signal: new AbortController().signal,
      launch: { root: sandbox.launchRoot, accountUid: 1000, paths: sandbox.paths },
    },
    async (source) => {
      for (const name of names) {
        published[name] = await readFile(join(source.sourceRoot, `bin/${name}`), "utf8");
      }
      expect(source.launchRoot).toBe(sandbox.launchRoot);
      return "published";
    },
  );

  expect(result).toBe("published");
  expect(published).toEqual(Object.fromEntries(names.map((name) => [name, `qualified ${name} bytes`])));
  for (const file of sandbox.syncOut.mock.calls.flatMap(([operations]) => operations.flatMap((op) => op.files))) {
    expect(file.sourcePath.startsWith(`${sandbox.remoteCwd}/.paperclip-runtime/`)).toBe(true);
  }
  // The export copy is scratch: it is removed and the qualified launch root is untouched.
  const exportParent = posix.join(sandbox.remoteCwd, ".paperclip-runtime", "paperclip-runner", "provider-artifact-export");
  expect(await readdir(exportParent)).toEqual([]);
  for (const name of names) await access(sandbox.paths[name]);
});

it("removes the confined staging copy when the export fails", async () => {
  const sandbox = await confinedSandbox();
  sandbox.syncOut.mockRejectedValueOnce(new Error("transfer failed"));
  const publish = vi.fn(async () => "must not publish");
  await expect(captureRemoteNativeProviderArtifacts(
    {
      runner: sandbox.runner,
      remoteCwd: sandbox.remoteCwd,
      manifest: sandbox.manifest,
      signal: new AbortController().signal,
      launch: { root: sandbox.launchRoot, accountUid: 1000, paths: sandbox.paths },
    },
    publish,
  )).rejects.toThrow("transfer failed");
  expect(publish).not.toHaveBeenCalled();
  const exportParent = posix.join(sandbox.remoteCwd, ".paperclip-runtime", "paperclip-runner", "provider-artifact-export");
  expect(await readdir(exportParent)).toEqual([]);
});

it("refuses a launch file replaced by a symlink instead of exporting its target", async () => {
  const sandbox = await confinedSandbox();
  const secret = join(sandbox.remoteCwd, "..", "secret");
  await writeFile(secret, "not a qualified artifact");
  await rm(sandbox.paths.opencodeProxy);
  await symlink(secret, sandbox.paths.opencodeProxy);
  const publish = vi.fn(async () => "must not publish");
  await expect(captureRemoteNativeProviderArtifacts(
    {
      runner: sandbox.runner,
      remoteCwd: sandbox.remoteCwd,
      manifest: sandbox.manifest,
      signal: new AbortController().signal,
      launch: { root: sandbox.launchRoot, accountUid: 1000, paths: sandbox.paths },
    },
    publish,
  )).rejects.toThrow("native_provider_artifacts_remote_unavailable");
  expect(sandbox.syncOut).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  const exportParent = posix.join(sandbox.remoteCwd, ".paperclip-runtime", "paperclip-runner", "provider-artifact-export");
  expect(await readdir(exportParent)).toEqual([]);
});
