import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_REMOTE_PROVIDER_PACK, resolveRemoteOpenCodeArtifacts } from "./remote-opencode-runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);

async function fixture(stdout = "Darwin\narm64\n") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-ssh-artifacts-"))); roots.push(root);
  const runtime = join(root, "darwin-arm64"), providerPack = join(runtime, "provider-pack"), runnerBinary = join(runtime, "bin/paperclip-runnerd");
  await mkdir(providerPack, { recursive: true }); await mkdir(join(runtime, "bin"));
  const binary = Buffer.alloc(64); binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x100000c, 4);
  await writeFile(runnerBinary, binary, { mode: 0o755 });
  const payload = { runnerSourceRevision: "a".repeat(40), target: { platform: "darwin", architecture: "arm64" } };
  const digest = hash(canonical(payload));
  await writeFile(join(providerPack, "provider-pack.json"), JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1", digest, payload }));
  await writeFile(join(runtime, "runtime.json"), JSON.stringify({ schema: "paperclip.runner.remote-runtime.v1", target: "darwin-arm64", sourceRevision: "a".repeat(40), providerPackDigest: digest, runnerSha256: hash(binary) }));
  const execute = vi.fn().mockResolvedValue({ stdout, stderr: "", exitCode: 0, timedOut: false });
  return { runtime, runnerBinary, providerPack, execute, input: { runner: { execute } as unknown as CommandManagedRuntimeRunner,
    remoteCwd: "/workspace", runtimeRoot: root } };
}

it.each([undefined, DEFAULT_REMOTE_PROVIDER_PACK])("selects the Mac daemon and pack instead of the inherited Linux default %s", async configuredProviderPack => {
  const f = await fixture();
  await expect(resolveRemoteOpenCodeArtifacts({ ...f.input, configuredProviderPack })).resolves.toEqual({ runnerBinary: f.runnerBinary, providerPack: f.providerPack });
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ command: "sh", bypassSession: true, timeoutMs: 10_000 }));
});

it("leaves Linux SSH runtime selection unchanged", async () => {
  const f = await fixture("Linux\nx86_64\n");
  await expect(resolveRemoteOpenCodeArtifacts(f.input)).resolves.toBeNull();
});

it.each([{ configuredProviderPack: "/operator/pack" }, { configuredRunner: "/operator/runnerd" }])("preserves explicit operator runtime selection %j", async override => {
  const f = await fixture();
  await expect(resolveRemoteOpenCodeArtifacts({ ...f.input, ...override })).resolves.toBeNull();
  expect(f.execute).not.toHaveBeenCalled();
});

it.each(["missing", "daemon", "source", "pack", "target", "permissions"])("rejects an unavailable or changed runtime: %s", async failure => {
  const f = await fixture();
  if (failure === "missing") await rm(join(f.runtime, "runtime.json"));
  if (failure === "daemon") await writeFile(f.runnerBinary, "different bytes");
  if (failure === "permissions") await chmod(f.runnerBinary, 0o644);
  if (["source", "pack", "target"].includes(failure)) {
    const file = join(f.runtime, "runtime.json"), metadata = JSON.parse(await readFile(file, "utf8"));
    if (failure === "source") metadata.sourceRevision = "b".repeat(40);
    if (failure === "pack") metadata.providerPackDigest = hash("different pack");
    if (failure === "target") metadata.target = "linux-x64";
    await writeFile(file, JSON.stringify(metadata));
  }
  await expect(resolveRemoteOpenCodeArtifacts(f.input)).rejects.toThrow("verified darwin-arm64");
});

it("does not launch with a controller binary when the SSH platform probe times out", async () => {
  const f = await fixture(); f.execute.mockResolvedValue({ stdout: "", stderr: "", exitCode: null, timedOut: true });
  await expect(resolveRemoteOpenCodeArtifacts(f.input)).rejects.toThrow("could not identify");
});

it("does not advertise Intel Mac qualification", async () => {
  const f = await fixture("Darwin\nx86_64\n");
  await expect(resolveRemoteOpenCodeArtifacts(f.input)).rejects.toThrow("requires Apple Silicon");
});
