import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_DISTRIBUTION_CLOSURE_SHA256 } from "./pi-closure-pins.js";
import { assertPiInstallationProfile, verifyPiInstallation } from "./pi-installation.js";
import { QUALIFIED_ACPX_PROFILES, type AcpxReleaseProfile } from "./qualified-profiles.js";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const candidate = (): AcpxReleaseProfile => ({ ...QUALIFIED_ACPX_PROFILES.pi });

async function withPiTestPlatform<T>(arch: "x64" | "arm64", run: () => Promise<T>): Promise<T> {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  if (!platformDescriptor || !archDescriptor) throw new Error("Missing process platform descriptors");
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    Object.defineProperty(process, "arch", { ...archDescriptor, value: arch });
    return await run();
  } finally {
    try { Object.defineProperty(process, "platform", platformDescriptor); }
    finally { Object.defineProperty(process, "arch", archDescriptor); }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-installation-test-")); roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@paperclipai/paperclip-runner" }));
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", root);
  vi.stubEnv("PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", join(root, "package.json"));
  const assets = join(root, "provider-assets/pi", `${process.platform}-${process.arch}`);
  await mkdir(join(assets, "runtime"), { recursive: true });
  return { root, assets };
}

describe("Pi installation factory", () => {
  it("pins the reviewed wrapper patch and runtime helper that its closure was built from", async () => {
    const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const helper = stripTypeScriptTypes(await readFile(new URL("./pi-acp-runtime.ts", import.meta.url), "utf8")).split("\n").map(line => line.trimEnd()).join("\n");
    const materializer = await readFile(new URL("../../../scripts/materialize-pi-distribution.mjs", import.meta.url), "utf8");
    expect(materializer).toContain(`helperSha256: "${hash(helper)}"`);
    expect(hash(await readFile(new URL("../../../../../patches/pi-acp@0.0.33.patch", import.meta.url)))).toBe("a7c63900b513490cceed9e41bc3bd06f03f2cd56265f434aa2c5dc7925fa76b4");
  });

  it("admits only the exact current profile", () => {
    const current = QUALIFIED_ACPX_PROFILES.pi.agentProfileVersion;
    expect(() => assertPiInstallationProfile(candidate())).not.toThrow();
    for (let prior = 1; prior < current; prior += 1) {
      expect(isSupportedAcpxProfileVersion("pi", prior)).toBe(true);
      expect(() => assertPiInstallationProfile({ ...candidate(), agentProfileVersion: prior })).toThrow(`version ${current}`);
    }
    for (const changed of [{ agentServerVersion: "latest" }, { commandDigest: `sha256:${"0".repeat(64)}` },
      // The last source-bound Pi identity.
      { commandDigest: "sha256:faafb66c09c1efc7eb4eda6baaa5813c975e8a992f9cd333687695aa5522d7dc" }, { agentRuntimePackage: "ambient-pi" }]) {
      expect(() => assertPiInstallationProfile({ ...candidate(), ...changed })).toThrow("trusted declaration");
    }
  });
  it("never takes closure authority from installed metadata", () => withPiTestPlatform("x64", async () => {
    const { assets } = await fixture();
    await writeFile(join(assets, "pi-distribution.json"), JSON.stringify({
      schema: "paperclip.pi-distribution.v1", runtimeRoot: "runtime", nativeClosureSha256: "0".repeat(64),
      target: { platform: process.platform, architecture: process.arch, nodeVersion: "24.21.0" },
      pins: { nodeVersion: "24.21.0", wrapper: "0.0.33", runtime: "1.0.0", sdk: "0.26.0", zod: "3.25.76" },
    }));
    await expect(verifyPiInstallation(candidate())).rejects.toThrow("trusted target pin");
  }));
  it("rejects an unsupported linux-arm64 target", () => withPiTestPlatform("arm64", async () => {
    expect(Object.hasOwn(PI_DISTRIBUTION_CLOSURE_SHA256, "linux-arm64")).toBe(false);
    await expect(verifyPiInstallation(candidate())).rejects.toThrow(/^Pi distribution target is unsupported$/);
  }));
  it.runIf(process.env.PAPERCLIP_TEST_PI_DISTRIBUTION_ROOT)("launches the actual closed Pi snapshot with bound subprocess paths", async () => {
    const { root, assets } = await fixture();
    await cp(process.env.PAPERCLIP_TEST_PI_DISTRIBUTION_ROOT!, assets, { recursive: true });
    const workspace = join(root, "workspace"); const agentHome = join(root, "agent");
    await mkdir(workspace); await mkdir(agentHome);
    const installation = await verifyPiInstallation(candidate());
    const command = await installation.openCommand();
    const child = command.spawn([], { cwd: workspace, env: {
      PATH: "/usr/bin:/bin", HOME: agentHome, PI_CODING_AGENT_DIR: agentHome,
      PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1", PAPERCLIP_PI_READ_ONLY: "1",
      PAPERCLIP_PI_READ_ROOTS: "[]", PAPERCLIP_PI_PROTECTED_ROOTS: JSON.stringify([agentHome]),
      PAPERCLIP_PI_ENTRYPOINT: "/unverified/ignored.js", PI_TELEMETRY: "0",
    } });
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    const decoder = new StringDecoder("utf8"); let buffer = ""; let id = 0;
    child.stdout!.on("data", chunk => {
      buffer += decoder.write(chunk);
      for (;;) {
        const at = buffer.indexOf("\n"); if (at < 0) break;
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line.trim()) continue;
        const value = JSON.parse(line); const waiter = pending.get(value.id);
        if (waiter) { pending.delete(value.id); if (value.error) waiter.reject(new Error(JSON.stringify(value.error))); else waiter.resolve(value.result); }
      }
    });
    child.once("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error(`Pi exited: ${stderr}`)); pending.clear(); });
    const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(new Error(`Pi snapshot admission timed out: ${stderr}`)), 15_000);
      pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
    try {
      const initialized = await call("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
      expect(initialized.agentCapabilities._meta.paperclipPi.steering).toBe(true);
      expect(initialized.authMethods).toEqual([]);
      await expect(call("session/new", { cwd: workspace, mcpServers: [] })).rejects.toThrow("Bind the configured OpenRouter API credential");
    } finally {
      child.stdin!.end();
      if (child.exitCode === null) { const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await once(child, "close"); clearTimeout(timer); }
      await command.close();
    }
  }, 90_000);

  it("refuses symlinked target assets and metadata", () => withPiTestPlatform("x64", async () => {
    const { root, assets } = await fixture();
    await rm(assets, { recursive: true });
    await symlink(root, assets);
    await expect(verifyPiInstallation(candidate())).rejects.toThrow("fixed asset directory");
  }));
});
