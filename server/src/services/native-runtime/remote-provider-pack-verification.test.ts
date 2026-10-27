import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
import { canonicalProviderPackJson, verifyRemoteProviderPack, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const manifest = (revision: string): ProviderPackIdentity => {
  const payload = {
    compatibility: { opencode: 1, acpx: 1 },
    pins: { opencode: "1.18.34", nodeMinimum: "24.11.0" },
    target: { platform: "linux", architecture: "x64" },
    runnerSourceRevision: revision.repeat(40),
    artifacts: Object.fromEntries(Object.entries({
      nodeCommand: "node_modules/node/bin/node", opencodeCommand: "node_modules/.bin/opencode",
      productionLock: "pnpm-lock.yaml", opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
      opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
      grokLauncher: "dist/providers/grok/launcher.cjs",
    }).map(([name, path]) => [name, { path, sha256: sha(`${revision}-${name}`) }])) as ProviderPackIdentity["payload"]["artifacts"],
  };
  return { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: sha(canonicalProviderPackJson(payload)) };
};

describe("installed provider pack compatibility", () => {
  it("reuses a protected pack across app revisions without executing verification commands", async () => {
    const installed = manifest("a");
    const current = structuredClone(installed);
    current.payload.runnerSourceRevision = "b".repeat(40);
    current.digest = sha(canonicalProviderPackJson(current.payload));
    const root = await mkdtemp(join(tmpdir(), "installed-pack-compatibility-"));
    await mkdir(dirname(join(root, installed.payload.artifacts.nodeCommand.path)), { recursive: true });
    await symlink(process.execPath, join(root, installed.payload.artifacts.nodeCommand.path));
    await writeFile(join(root, "provider-pack.json"), JSON.stringify(installed));
    const execute = vi.fn(async (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
      try {
        const result = await promisify(execFile)(request.command, request.args ?? [], { cwd: root, timeout: 2_000 });
        return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString() };
      } catch (error) {
        const failed = error as Error & { code: number; stdout: string; stderr: string };
        if (typeof failed.code !== "number") throw error;
        return { stdout: failed.stdout, stderr: failed.stderr, exitCode: failed.code, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString() };
      }
    });
    const input = { runner: { execute }, cwd: root, packRoot: root, manifest: current };
    try {
      // Exercise the old complete-manifest comparison in a real Node process.
      // Only provenance changed; provider bytes and interface are identical.
      await expect(verifyRemoteProviderPack(input)).rejects.toThrow("manifest mismatch");
      expect(execute).toHaveBeenCalledOnce();
      execute.mockClear();
      const selected = await verifyRemoteProviderPack({ ...input,
        installation: { root, manifest: installed, immutable: true }, provider: { kind: "opencode" } });
      expect(selected).toEqual(installed);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const reseal = (pack: ProviderPackIdentity) => ({ ...pack, digest: sha(canonicalProviderPackJson(pack.payload)) });
  const check = (installed: ProviderPackIdentity, options: { immutable?: boolean; requireExactIdentity?: boolean } = {}) => {
    const execute = vi.fn();
    return verifyRemoteProviderPack({ runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: manifest("b"), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: installed, immutable: options.immutable ?? true },
      provider: { kind: "opencode" }, requireExactIdentity: options.requireExactIdentity });
  };
  it.each(["interface", "platform", "schema", "artifact_path", "digest", "legacy"])("rejects an incompatible %s", async field => {
    let pack = manifest("a");
    if (field === "interface") pack.payload.compatibility!.opencode += 1;
    if (field === "legacy") delete pack.payload.compatibility;
    if (field === "platform") pack.payload.target.architecture = "arm64";
    if (field === "schema") pack.schema = "unknown";
    if (field === "artifact_path") pack.payload.artifacts.nodeCommand.path = "../node";
    pack = reseal(pack);
    if (field === "digest") pack.digest = sha("corrupt");
    await expect(check(pack)).rejects.toThrow("runner_remote_provider_artifact_incompatible");
  });
  it("keeps writable installations at the content-verification boundary", async () => {
    await expect(check(manifest("b"), { immutable: false })).rejects.toThrow("installation is incompatible");
  });
  it("does not replace an admitted pack during reattachment", async () => {
    await expect(check(manifest("a"), { requireExactIdentity: true })).rejects.toThrow("incompatible");
    await expect(check(manifest("b"), { requireExactIdentity: true })).resolves.toEqual(manifest("b"));
  });
  it("ignores unrelated provider and dependency changes for OpenCode", async () => {
    const pack = manifest("a");
    pack.payload.compatibility!.acpx += 1;
    pack.payload.pins.acpx = "different-version";
    pack.payload.acpxProfileDigests = { codex: sha("different-codex") };
    await expect(check(reseal(pack))).resolves.toEqual(reseal(pack));
  });
  it("checks only the selected ACPX profile", async () => {
    const current = manifest("b"), installed = manifest("a");
    current.payload.acpxProfileDigests = { claude: sha("claude"), codex: sha("codex") };
    installed.payload.acpxProfileDigests = { claude: sha("claude"), codex: sha("other-codex") };
    const input = { runner: { execute: vi.fn() }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: reseal(installed), immutable: true },
      provider: { kind: "acpx" as const, agent: "claude" } };
    await expect(verifyRemoteProviderPack(input)).resolves.toEqual(reseal(installed));
    await expect(verifyRemoteProviderPack({ ...input, provider: { kind: "acpx", agent: "codex" } })).rejects.toThrow("profile is incompatible");
  });

});
