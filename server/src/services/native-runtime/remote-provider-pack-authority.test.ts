import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { providerPackWorkspaceId, recordAdmittedRemoteProviderPack, resolveRemoteProviderPackAuthority } from "./remote-provider-pack-authority.js";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const binding = { companyId: "company", agentId: "agent", workspaceId: "workspace", sessionId: "session",
  runnerInstanceId: "runner", environmentLeaseId: "lease", remoteCwd: "/workspace", providerDigest: "provider" };
const runnerArtifact = () => ({ version: "0.0.0", digest: "sha256:" + "c".repeat(64) });
const manifest = (revision: string) => {
  const payload = { runnerSourceRevision: revision.repeat(40), target: { platform: "linux", architecture: "x64" },
    pins: { opencode: "1.18.34" }, artifacts: { nodeCommand: { path: "node", sha256: "sha256:" + "1".repeat(64) },
      opencodeCommand: { path: "opencode", sha256: "sha256:" + "2".repeat(64) } } };
  return { schema: "paperclip-runner/remote-provider-pack/v1", payload,
    digest: "sha256:" + createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex") };
};
it("reattaches with the verified launch authority after the controller release changes", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "provider-pack-authority-")); directories.push(stateDirectory);
  const original = manifest("a"), next = manifest("b");
  const launched = resolveRemoteProviderPackAuthority({ stateDirectory, binding, reattach: false, runnerArtifact, current: () => original });
  launched.verified();
  const current = vi.fn(() => next);
  const recovered = resolveRemoteProviderPackAuthority({ stateDirectory, binding, reattach: true, current, runnerArtifact });
  expect(recovered.manifest).toEqual(original);
  expect(recovered.runnerArtifact).toEqual(runnerArtifact());
  expect(current).not.toHaveBeenCalled();
});

function fixture() {
  const stateDirectory = mkdtempSync(join(tmpdir(), "provider-pack-authority-")); directories.push(stateDirectory);
  const current = vi.fn(() => manifest("a"));
  const input = { stateDirectory, binding, reattach: false, current, runnerArtifact };
  return { input, path: join(stateDirectory, "provider-pack-authority.json") };
}
it("uses the new release for a fresh launch without changing the old receipt until verification", () => {
  const { input, path } = fixture();
  resolveRemoteProviderPackAuthority(input).verified();
  input.current.mockReturnValue(manifest("b"));
  const fresh = resolveRemoteProviderPackAuthority(input);
  expect(fresh.manifest).toEqual(manifest("b"));
  expect(JSON.parse(readFileSync(path, "utf8")).manifest).toEqual(manifest("a"));
  fresh.verified();
  expect(JSON.parse(readFileSync(path, "utf8")).manifest).toEqual(manifest("b"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
it("keeps historical sessions without a receipt at the current release integrity gate", () => {
  const { input } = fixture();
  const recovered = resolveRemoteProviderPackAuthority({ ...input, reattach: true });
  expect(recovered.manifest).toEqual(manifest("a"));
  expect(input.current).toHaveBeenCalledOnce();
});
it.each(Object.keys(binding) as (keyof typeof binding)[])("rejects a saved authority for a different %s", field => {
  const { input } = fixture();
  resolveRemoteProviderPackAuthority(input).verified();
  expect(() => resolveRemoteProviderPackAuthority({ ...input, reattach: true,
    binding: { ...binding, [field]: "other" } })).toThrow("does not match this execution");
  expect(input.current).toHaveBeenCalledOnce();
});
it.each(["digest", "schema", "symlink", "oversized", "invalid_json"])("fails closed on %s instead of trusting remote or current bytes", kind => {
  const { input, path } = fixture();
  resolveRemoteProviderPackAuthority(input).verified();
  const saved = JSON.parse(readFileSync(path, "utf8"));
  if (kind === "digest") saved.manifest.payload.runnerSourceRevision = "c".repeat(40);
  if (kind === "schema") saved.schema = "unknown";
  writeFileSync(path, JSON.stringify(saved));
  if (kind === "invalid_json") writeFileSync(path, "{");
  if (kind === "oversized") writeFileSync(path, " ".repeat(512 * 1024 + 1));
  if (kind === "symlink") { const copy = path + ".copy"; writeFileSync(copy, JSON.stringify(saved)); rmSync(path); symlinkSync(copy, path); }
  expect(() => resolveRemoteProviderPackAuthority({ ...input, reattach: true })).toThrow("saved provider pack authority");
  expect(input.current).toHaveBeenCalledOnce();
});

it("uses current authority for a replacement lease instead of restoring the prior pack", () => {
  const { input, path } = fixture();
  resolveRemoteProviderPackAuthority(input).verified();
  const currentRunner = { version: "0.0.1", digest: "sha256:" + "d".repeat(64) };
  const replacement = resolveRemoteProviderPackAuthority({ ...input, binding: { ...binding, environmentLeaseId: "replacement" },
    current: () => manifest("b"), runnerArtifact: () => currentRunner });
  expect(replacement.manifest).toEqual(manifest("b"));
  expect(replacement.runnerArtifact).toEqual(currentRunner);
  replacement.verified();
  expect(JSON.parse(readFileSync(path, "utf8")).binding.environmentLeaseId).toBe("replacement");
});
it("retains the authenticated daemon identity across controller daemon replacement", () => {
  const { input } = fixture();
  resolveRemoteProviderPackAuthority(input).verified();
  const changedRunner = vi.fn(() => ({ version: "new", digest: "sha256:" + "d".repeat(64) }));
  const recovered = resolveRemoteProviderPackAuthority({ ...input, reattach: true, runnerArtifact: changedRunner });
  expect(recovered.runnerArtifact).toEqual(runnerArtifact());
  expect(changedRunner).not.toHaveBeenCalled();
});
it.each([{}, { version: "0.0.0", digest: "not-a-sha256" }])("rejects an invalid saved daemon identity: %j", runnerArtifact => {
  const { input, path } = fixture();
  resolveRemoteProviderPackAuthority(input).verified();
  const saved = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...saved, runnerArtifact }));
  expect(() => resolveRemoteProviderPackAuthority({ ...input, reattach: true })).toThrow("saved provider pack authority");
});

it("keeps admitted session ownership with the caller if receipt storage or its warning fails", async () => {
  const { input, path } = fixture();
  mkdirSync(path);
  const authority = resolveRemoteProviderPackAuthority(input);
  const warning = vi.fn(() => { throw new Error("log unavailable"); });
  await expect(recordAdmittedRemoteProviderPack(authority, warning)).resolves.toBe(false);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("could not save remote release authority"));
  expect(() => resolveRemoteProviderPackAuthority({ ...input, reattach: true })).toThrow("saved provider pack authority");
});
it("retains the original projectless lease across warm run placeholders but rejects a different real workspace", () => {
  const { input } = fixture();
  const first = { ...binding, workspaceId: providerPackWorkspaceId("run-1", "run-1", "original-lease") };
  resolveRemoteProviderPackAuthority({ ...input, binding: first }).verified();
  const next = { ...binding, workspaceId: providerPackWorkspaceId("run-2", "run-2", "original-lease") };
  expect(resolveRemoteProviderPackAuthority({ ...input, binding: next, reattach: true }).manifest).toEqual(manifest("a"));
  const changed = { ...binding, workspaceId: providerPackWorkspaceId("project-workspace", "run-2", "original-lease") };
  expect(() => resolveRemoteProviderPackAuthority({ ...input, binding: changed, reattach: true })).toThrow("does not match this execution");
});

it("persists the compatible installation selected at launch, then pins it on reattachment", () => {
  const { input } = fixture();
  const authority = resolveRemoteProviderPackAuthority(input);
  const installed = manifest("b");
  authority.select(installed);
  authority.verified();
  const attached = resolveRemoteProviderPackAuthority({ ...input, reattach: true });
  expect(attached.manifest).toEqual(installed);
  expect(() => attached.select(manifest("c"))).toThrow("cannot replace an attached pack authority");
});
