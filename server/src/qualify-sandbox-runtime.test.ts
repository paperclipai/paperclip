import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { qualifySandboxRuntime } from "./qualify-sandbox-runtime.js";
import { canonicalProviderPackJson, type ProviderPackIdentity } from "./services/native-runtime/provider-pack-compatibility.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const reseal = (manifest: ProviderPackIdentity) => ({ ...manifest, digest: `sha256:${hash(canonicalProviderPackJson(manifest.payload))}` });
const pack = (revision: string): ProviderPackIdentity => reseal({
  schema: "paperclip-runner/remote-provider-pack/v1", digest: "",
  payload: { compatibility: { opencode: 1, acpx: 1 }, contractDigest: `sha256:${hash("interface")}`,
    pins: { opencode: "1.2.3" }, target: { platform: "linux", architecture: "x64" }, runnerSourceRevision: revision.repeat(40),
    acpxProfileDigests: { claude: hash("claude-profile") }, artifacts: {
      nodeCommand: { path: "node/bin/node", sha256: `sha256:${hash(`${revision}-node`)}` },
      opencodeCommand: { path: "opencode", sha256: `sha256:${hash(`${revision}-opencode`)}` },
    } },
});
const expected = { manifest: pack("b"), runnerSha256: hash("same-runner") };
const input = () => ({ installed: { manifest: pack("a"), runnerSha256: expected.runnerSha256, immutable: true },
  providers: [{ kind: "opencode" as const }, { kind: "acpx" as const, agent: "claude" }] });

describe("deployment sandbox runtime qualification", () => {
  it("accepts different publication hashes when the runtime contract and requested profiles agree", () => {
    const report = qualifySandboxRuntime(input(), expected);
    expect(report.compatible).toBe(true);
    expect(report.installedPackDigest).not.toBe(report.expectedPackDigest);
  });

  it.each(["runner", "protection", "contract", "revision", "profile", "digest"])("refuses an incompatible %s", change => {
    const value = input();
    if (change === "runner") value.installed.runnerSha256 = hash("other-runner");
    if (change === "protection") value.installed.immutable = false;
    if (change === "contract") value.installed.manifest.payload.contractDigest = `sha256:${hash("other-interface")}`;
    if (change === "revision") value.installed.manifest.payload.compatibility!.acpx++;
    if (change === "profile") value.installed.manifest.payload.acpxProfileDigests!.claude = hash("other-profile");
    value.installed.manifest = reseal(value.installed.manifest);
    if (change === "digest") value.installed.manifest.digest = `sha256:${hash("corrupt")}`;
    expect(qualifySandboxRuntime(value, expected)).toMatchObject({ compatible: false, failedCheck: expect.any(String) });
  });

  it("checks every packaged provider by default, including candidate profiles", () => {
    const candidate = pack("b");
    candidate.payload.acpxProfileDigests!.codex = hash("codex-profile");
    const expectedAll = { ...expected, manifest: reseal(candidate) };
    const report = qualifySandboxRuntime({ installed: input().installed }, expectedAll);
    expect(report).toMatchObject({ compatible: false, allPackProviders: true });
    expect(report.providers).toContainEqual({ kind: "acpx", agent: "codex" });
    expect(qualifySandboxRuntime(input(), expectedAll)).toMatchObject({ compatible: true, allPackProviders: false });
  });

  it("leaves unrequested provider profiles outside deployment policy", () => {
    const value = input();
    value.installed.manifest.payload.acpxProfileDigests!.unrequested = hash("other-profile");
    value.installed.manifest = reseal(value.installed.manifest);
    expect(qualifySandboxRuntime(value, expected).compatible).toBe(true);
  });

  it("ships an offline command with distinct compatible, incompatible and invalid outcomes", () => {
    const directory = mkdtempSync(join(tmpdir(), "sandbox-runtime-qualification-"));
    try {
      const entry = join(directory, "qualify.mjs"), manifest = join(directory, "provider-pack.json"), runner = join(directory, "runnerd");
      buildSync({ entryPoints: [fileURLToPath(new URL("./qualify-sandbox-runtime.ts", import.meta.url))],
        outfile: entry, bundle: true, platform: "node", format: "esm" });
      writeFileSync(manifest, JSON.stringify(expected.manifest));
      writeFileSync(runner, "same-runner");
      const run = (source: string) => spawnSync(process.execPath, [entry, "--manifest", manifest, "--runner", runner],
        { input: source, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 5_000 });
      const accepted = run(JSON.stringify(input()));
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout)).toMatchObject({ compatible: true, expectedPackDigest: expected.manifest.digest });
      const invalid = input(); invalid.installed.runnerSha256 = hash("other-runner");
      expect(run(JSON.stringify(invalid)).status).toBe(2);
      expect(run("invalid JSON").status).toBe(1);
      const { manifest: _manifest, ...withoutManifest } = input().installed;
      expect(run(JSON.stringify({ installed: withoutManifest })).status).toBe(1);
      expect(run(JSON.stringify({ installed: { ...withoutManifest, manifest: {} } })).status).toBe(1);
      expect(readFileSync(manifest, "utf8")).toBe(JSON.stringify(expected.manifest));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
