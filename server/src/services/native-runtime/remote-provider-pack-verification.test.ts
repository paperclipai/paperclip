import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
import { canonicalProviderPackJson, clearSealedProviderPacksForTest, PROVIDER_PACK_IDENTITY_FUNCTION, verifyRemoteProviderPack, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const manifest = (revision: string): ProviderPackIdentity => {
  const payload = {
    compatibility: { opencode: 1, acpx: 1 },
    contractDigest: sha("contracts"),
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
  it("finishes both startup checks when a gateway recovers between verification attempts", async () => {
    vi.useFakeTimers();
    try {
      const expected = manifest("b");
      const availableAt = Date.now() + 1_000;
      const execute = vi.fn(async (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        if (Date.now() < availableAt) throw new Error("Request failed with status code 502");
        return { exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stderr: "",
          stdout: request.args?.[0] === "--version" ? `${expected.payload.pins.opencode}\n` : "verified" };
      });
      const verification = verifyRemoteProviderPack({ runner: { execute }, cwd: "/workspace",
        packRoot: "/workspace/provider-pack", manifest: expected }).then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(999);
      expect(execute).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(await verification).toEqual({ value: expected });
      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute.mock.calls[2][0].args).toEqual(["--version"]);
    } finally {
      vi.useRealTimers();
    }
  });
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
      await expect(verifyRemoteProviderPack(input)).rejects.toMatchObject({
        message: expect.stringContaining("manifest mismatch"), failureCheck: "manifest_mismatch:runnerSourceRevision" });
      expect(execute).toHaveBeenCalledOnce();
      // The sealing variant of the verifier runs the same checks in a real Node process.
      await expect(verifyRemoteProviderPack({ ...input, seal: { targetKey: "sandbox:env:real" } })).rejects.toMatchObject({
        failureCheck: "manifest_mismatch:runnerSourceRevision" });
      await expect(verifyRemoteProviderPack({ ...input, manifest: installed, seal: { targetKey: "sandbox:env:real" } })).rejects.toMatchObject({
        failureCheck: "artifact_digest:nodeCommand" });
      await expect(verifyRemoteProviderPack({ ...input, manifest: installed })).rejects.toMatchObject({
        message: expect.stringContaining("nodeCommand digest mismatch"), failureCheck: "artifact_digest:nodeCommand" });
      await rm(join(root, "provider-pack.json"));
      await expect(verifyRemoteProviderPack(input)).rejects.toMatchObject({ failureCheck: "manifest_unreadable" });
      const combined = vi.fn(async (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const result = await execute(request);
        return { ...result, stdout: `${result.stdout}${result.stderr}`, stderr: "" };
      });
      await expect(verifyRemoteProviderPack({ ...input, runner: { execute: combined } }))
        .rejects.toMatchObject({ failureCheck: "manifest_unreadable" });
      await writeFile(join(root, "provider-pack.json"), JSON.stringify(installed));
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
  const check = (installed: ProviderPackIdentity, options: { immutable?: boolean; requireExactIdentity?: boolean; requireCurrentOpenCodeProxy?: boolean } = {}) => {
    const execute = vi.fn();
    return verifyRemoteProviderPack({ runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: manifest("b"), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: installed, immutable: options.immutable ?? true },
      provider: { kind: "opencode" }, requireExactIdentity: options.requireExactIdentity,
      requireCurrentOpenCodeProxy: options.requireCurrentOpenCodeProxy });
  };
  it.each([
    ["interface", "compatibility_revision"], ["contracts", "contract_digest"], ["platform", "target"], ["schema", "schema"],
    ["artifact_path", "artifact:nodeCommand"], ["digest", "manifest_digest"], ["legacy", "compatibility_revision"],
    ["legacy_contracts", "contract_digest_missing"],
  ])("names the failed check for an incompatible %s", async (field, failureCheck) => {
    let pack = manifest("a");
    if (field === "interface") pack.payload.compatibility!.opencode += 1;
    if (field === "contracts") pack.payload.contractDigest = sha("other-contracts");
    if (field === "legacy") delete pack.payload.compatibility;
    if (field === "legacy_contracts") delete pack.payload.contractDigest;
    if (field === "platform") pack.payload.target.architecture = "arm64";
    if (field === "schema") pack.schema = "unknown";
    if (field === "artifact_path") pack.payload.artifacts.nodeCommand.path = "../node";
    pack = reseal(pack);
    if (field === "digest") pack.digest = sha("corrupt");
    await expect(check(pack)).rejects.toMatchObject({ failureCheck });
  });
  it("names unprotected, exact-identity and proxy rejections", async () => {
    await expect(check(manifest("b"), { immutable: false })).rejects.toMatchObject({ failureCheck: "installation_unprotected" });
    await expect(check(manifest("a"), { requireExactIdentity: true })).rejects.toMatchObject({ failureCheck: "exact_identity" });
    await expect(check(manifest("a"), { requireCurrentOpenCodeProxy: true })).rejects.toMatchObject({ failureCheck: "opencode_proxy" });
    const unpinned = manifest("b");
    (unpinned.payload.pins as Record<string, unknown>).opencode = null;
    await expect(check(reseal(unpinned))).rejects.toMatchObject({ failureCheck: "opencode_pin_missing" });
  });
  it.each(["interface", "contracts", "platform", "schema", "artifact_path", "digest", "legacy", "legacy_contracts"])("rejects an incompatible %s", async field => {
    let pack = manifest("a");
    if (field === "interface") pack.payload.compatibility!.opencode += 1;
    if (field === "contracts") pack.payload.contractDigest = sha("other-contracts");
    if (field === "legacy") delete pack.payload.compatibility;
    if (field === "legacy_contracts") delete pack.payload.contractDigest;
    if (field === "platform") pack.payload.target.architecture = "arm64";
    if (field === "schema") pack.schema = "unknown";
    if (field === "artifact_path") pack.payload.artifacts.nodeCommand.path = "../node";
    pack = reseal(pack);
    if (field === "digest") pack.digest = sha("corrupt");
    await expect(check(pack)).rejects.toThrow("runner_remote_provider_artifact_incompatible");
  });
  it("accepts a reported installed manifest only when its sealed content equals the expected pack", async () => {
    const expected = manifest("b");
    const report = (installed: unknown) => vi.fn(async (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => ({
      exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stderr: "",
      stdout: request.args?.[0] === "--version" ? "1.18.34\n"
        : `\npaperclip-pack-manifest=${Buffer.from(JSON.stringify(installed)).toString("base64")}\n` }));
    const input = { cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack", manifest: expected, acceptProvenance: true };
    const otherBuild = manifest("b");
    otherBuild.payload.runnerSourceRevision = "a".repeat(40);
    await expect(verifyRemoteProviderPack({ ...input, runner: { execute: report(reseal(otherBuild)) } })).resolves.toEqual(reseal(otherBuild));
    const otherContent = reseal({ ...otherBuild, payload: { ...otherBuild.payload, contractDigest: sha("other") } });
    await expect(verifyRemoteProviderPack({ ...input, runner: { execute: report(otherContent) } }))
      .rejects.toMatchObject({ failureCheck: "installed_manifest_invalid" });
    await expect(verifyRemoteProviderPack({ ...input, runner: { execute: report({ ...reseal(otherBuild), digest: sha("unsealed") }) } }))
      .rejects.toMatchObject({ failureCheck: "installed_manifest_invalid" });
    await expect(verifyRemoteProviderPack({ ...input, acceptProvenance: false, runner: { execute: report(reseal(otherBuild)) } }))
      .resolves.toEqual(expected);
  });
  it("does not reuse image packs when the controller's bundled pack records no contract digest", async () => {
    const current = manifest("b");
    delete current.payload.contractDigest;
    const installed = manifest("a");
    await expect(verifyRemoteProviderPack({ runner: { execute: vi.fn() }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: installed, immutable: true },
      provider: { kind: "opencode" } })).rejects.toThrow("interface or installation is incompatible");
  });
  it("keeps writable installations at the content-verification boundary", async () => {
    await expect(check(manifest("b"), { immutable: false })).rejects.toThrow("installation is incompatible");
  });
  it("does not replace an admitted pack during reattachment", async () => {
    await expect(check(manifest("a"), { requireExactIdentity: true })).rejects.toThrow("incompatible");
    await expect(check(manifest("b"), { requireExactIdentity: true })).resolves.toEqual(manifest("b"));
  });
  it("requires the current proxy for requested OpenCode diagnostics", async () => {
    const installed = manifest("a");
    await expect(check(installed)).resolves.toEqual(installed);
    await expect(check(installed, { requireCurrentOpenCodeProxy: true }))
      .rejects.toThrow("requested OpenCode diagnostics");
    installed.payload.artifacts.opencodeProxy = manifest("b").payload.artifacts.opencodeProxy;
    await expect(check(reseal(installed), { requireCurrentOpenCodeProxy: true }))
      .resolves.toEqual(reseal(installed));
  });
  it("ignores unrelated provider and dependency changes for OpenCode", async () => {
    const pack = manifest("a");
    pack.payload.compatibility!.acpx += 1;
    pack.payload.pins.acpx = "different-version";
    pack.payload.acpxProfileDigests = { codex: sha("different-codex") };
    await expect(check(reseal(pack))).resolves.toEqual(reseal(pack));
  });
  it("treats the Runner image inputs digest as provenance", async () => {
    // A pack built in the Runner image records which image it came from. The
    // controller's own pack may record another image, or none.
    const pack = manifest("a");
    pack.payload.runnerInputsDigest = "c".repeat(64);
    await expect(check(reseal(pack))).resolves.toEqual(reseal(pack));
    // The field is part of the sealed payload, so it cannot change unnoticed.
    await expect(check({ ...reseal(pack), payload: { ...pack.payload, runnerInputsDigest: "d".repeat(64) } }))
      .rejects.toThrow("runner_remote_provider_artifact_incompatible");
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

  describe("sealed reuse on the same sandbox", () => {
    const identityOf = async (root: string) => {
      const { stdout } = await promisify(execFile)(process.execPath, ["-e",
        `${PROVIDER_PACK_IDENTITY_FUNCTION};process.stdout.write(packIdentity(process.argv[1]))`, root]);
      return stdout;
    };

    it("changes the identity for any same-size rewrite, even with its mtime restored", async () => {
      const root = await mkdtemp(join(tmpdir(), "pack-identity-"));
      try {
        await mkdir(join(root, "dist"));
        await writeFile(join(root, "dist", "file.js"), "original");
        await symlink(join(root, "dist", "file.js"), join(root, "link.js"));
        const sealed = await identityOf(root);
        expect(sealed).toMatch(/^[a-f0-9]{64}$/);
        expect(await identityOf(root)).toBe(sealed);
        const before = await stat(join(root, "dist", "file.js"));
        await new Promise(resolve => setTimeout(resolve, 20));
        await writeFile(join(root, "dist", "file.js"), "tampered");
        await utimes(join(root, "dist", "file.js"), before.atime, before.mtime);
        expect(await identityOf(root)).not.toBe(sealed);
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it("re-checks only the identity on a sealed sandbox and fully re-verifies after any change", async () => {
      clearSealedProviderPacksForTest();
      const expected = manifest("b");
      let identity = "a".repeat(64);
      const execute = vi.fn(async (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
        const script = String(request.args?.[1] ?? "");
        const stdout = request.args?.[0] === "--version" ? `${expected.payload.pins.opencode}\n`
          : script.includes("paperclip-pack-check") ? `verified\npaperclip-pack-identity=${identity}\n`
            : `\npaperclip-pack-identity=${identity}\n`;
        return { exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stderr: "", stdout };
      });
      const kinds = () => execute.mock.calls.map(([request]) => request.args?.[0] === "--version" ? "version"
        : String(request.args?.[1]).includes("paperclip-pack-check") ? "full" : "identity");
      const input = { runner: { execute }, cwd: "/workspace", packRoot: "/workspace/provider-pack", manifest: expected,
        seal: { targetKey: "sandbox:env-1:sandbox-1" } };
      await expect(verifyRemoteProviderPack(input)).resolves.toEqual(expected);
      expect(kinds()).toEqual(["full", "version"]);
      execute.mockClear();
      await expect(verifyRemoteProviderPack(input)).resolves.toEqual(expected);
      expect(kinds()).toEqual(["identity"]);
      // Another sandbox, or no sandbox identity, never reuses the seal.
      execute.mockClear();
      await verifyRemoteProviderPack({ ...input, seal: { targetKey: "sandbox:env-1:sandbox-2" } });
      await verifyRemoteProviderPack({ ...input, seal: undefined });
      expect(kinds()).toEqual(["full", "version", "full", "version"]);
      // A changed identity falls back to the complete verification.
      execute.mockClear();
      identity = "b".repeat(64);
      await expect(verifyRemoteProviderPack(input)).resolves.toEqual(expected);
      expect(kinds()).toEqual(["identity", "full", "version"]);
      // A pack that changed while it was hashed reports no identity and is not sealed.
      execute.mockClear();
      clearSealedProviderPacksForTest();
      execute.mockImplementation(async (request) => ({ exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stderr: "",
        stdout: request.args?.[0] === "--version" ? `${expected.payload.pins.opencode}\n` : "verified\n" }));
      await verifyRemoteProviderPack(input);
      await verifyRemoteProviderPack(input);
      expect(kinds()).toEqual(["full", "version", "full", "version"]);
    });
  });

  it("rejects the published Grok pack from before native effort admission", async () => {
    const profiles = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/acpx-profiles.json", import.meta.url), "utf8"));
    const current = manifest("b"), installed = manifest("a");
    // Published builtin Grok profile 1 predates grokEffort and grokDisableWebSearch
    // in session.open. Its launcher bytes equal today's, so its release digest
    // matches; the pack predates contract digests, so that gate refuses it.
    const published = "sha256:f0b698395a3704ed2ffaf84ea19bdb20c36c8a0a70b7c629c7b6ffe144e59e55";
    expect(profiles.profiles.grok.commandDigest).toBe(published);
    installed.payload.acpxProfileDigests = { grok: published };
    delete installed.payload.contractDigest;
    current.payload.acpxProfileDigests = { grok: profiles.profiles.grok.commandDigest };
    const execute = vi.fn();
    await expect(verifyRemoteProviderPack({ runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: reseal(installed), immutable: true },
      provider: { kind: "acpx", agent: "grok" } })).rejects.toThrow("interface or installation is incompatible");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an installed pack with another Grok release digest", async () => {
    const profiles = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/acpx-profiles.json", import.meta.url), "utf8"));
    const current = manifest("b"), installed = manifest("a");
    // The last source-bound Grok profile digest.
    installed.payload.acpxProfileDigests = { grok: "sha256:5205c2197b94cfbd3e62fbeea027f2e80d092f736ca52656dda2f7044ba9a5ca" };
    current.payload.acpxProfileDigests = { grok: profiles.profiles.grok.commandDigest };
    const execute = vi.fn();
    await expect(verifyRemoteProviderPack({ runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: reseal(installed), immutable: true },
      provider: { kind: "acpx", agent: "grok" } })).rejects.toThrow("selected ACPX provider profile is incompatible");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reuses the current Grok profile across source-only changes and retains exact historical recovery authority", async () => {
    const profiles = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/acpx-profiles.json", import.meta.url), "utf8"));
    const current = manifest("b"), installed = manifest("a");
    for (const pack of [current, installed]) pack.payload.acpxProfileDigests = { grok: profiles.profiles.grok.commandDigest };
    const execute = vi.fn();
    const input = { runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: reseal(installed), immutable: true },
      provider: { kind: "acpx" as const, agent: "grok" } };
    await expect(verifyRemoteProviderPack(input)).resolves.toEqual(reseal(installed));
    const historical = manifest("a");
    historical.payload.acpxProfileDigests = { grok: "sha256:5205c2197b94cfbd3e62fbeea027f2e80d092f736ca52656dda2f7044ba9a5ca" };
    await expect(verifyRemoteProviderPack({ ...input, manifest: reseal(historical),
      installation: { ...input.installation, manifest: reseal(historical) }, requireExactIdentity: true })).resolves.toEqual(reseal(historical));
    expect(execute).not.toHaveBeenCalled();
  });

});
