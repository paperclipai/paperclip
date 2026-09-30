import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_DISTRIBUTION_CLOSURE_SHA256 } from "./pi-closure-pins.js";
import { PI_NODE_VERSION } from "./pi-node-pins.js";
import { assertPiInstallationProfile, verifyPiInstallation } from "./pi-installation.js";
import { QUALIFIED_ACPX_PROFILES, type QualifiedAcpxProfile } from "./qualified-profiles.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const candidate = (): QualifiedAcpxProfile => ({ ...QUALIFIED_ACPX_PROFILES.pi, agentProfileVersion: 8 });

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
  it("binds the profile declaration to the reviewed patch and platform closure pins", async () => {
    const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
    const identity = JSON.parse(await readFile(new URL("../../../test-fixtures/pi-acp/profile-v8-identity.json", import.meta.url), "utf8"));
    const declaration = identity.declaration;
    expect(identity.commandDigest).toBe(`sha256:${hash(canonical(declaration))}`);
    expect(QUALIFIED_ACPX_PROFILES.pi.commandDigest).toBe(identity.commandDigest);
    for (const key of ["agent", "agentProfileVersion", "acpxVersion", "agentServerVersion", "agentRuntimeVersion"] as const) {
      expect(declaration[key]).toBe(QUALIFIED_ACPX_PROFILES.pi[key]);
    }
    expect(declaration.closure).toEqual(PI_DISTRIBUTION_CLOSURE_SHA256);
    expect(declaration.nodeVersion).toBe(PI_NODE_VERSION);
    expect(hash(await readFile(new URL("../../../../../patches/acpx@0.13.1.patch", import.meta.url)))).toBe(declaration.acpxPatchSha256);
    expect(hash(await readFile(new URL("./pi-message-projection.ts", import.meta.url)))).toBe(declaration.messageProjectionSha256);
    expect(hash(await readFile(new URL("./pi-extension-adapter.ts", import.meta.url)))).toBe(declaration.noticeProjectionSha256);
    const helper = stripTypeScriptTypes(await readFile(new URL("./pi-acp-runtime.ts", import.meta.url), "utf8")).split("\n").map(line => line.trimEnd()).join("\n");
    const extension = stripTypeScriptTypes(await readFile(new URL("./pi-runtime-extension.ts", import.meta.url), "utf8")).replace('from "./pi-acp-runtime.js"', 'from "../node_modules/pi-acp/dist/paperclip-runtime.js"');
    expect(hash(helper)).toBe(declaration.helperSha256);
    expect(hash(extension)).toBe(declaration.extensionSha256);
    const materializer = await readFile(new URL("../../../scripts/materialize-pi-distribution.mjs", import.meta.url), "utf8");
    expect(materializer).toContain(`wrapperSha256: "${declaration.wrapperSha256}"`);
    expect(materializer).toContain(`helperSha256: "${declaration.helperSha256}"`);
    // This exact patch produced the independently verified v8 wrapper/closure.
    // Pin it separately so wrapper-only edits cannot keep an unchanged declaration.
    expect(hash(await readFile(new URL("../../../../../patches/pi-acp@0.0.33.patch", import.meta.url)))).toBe("821896c48f23f0a1a5c5856d9d3b87c905e261b28c3ed8e1bbd3f7242ec48b22");
  });

  it("rejects legacy profiles and caller-selected identities", () => {
    expect(() => assertPiInstallationProfile(candidate())).not.toThrow();
    expect(() => assertPiInstallationProfile({ ...candidate(), agentProfileVersion: 1 })).toThrow("version 8");
    expect(() => assertPiInstallationProfile({ ...candidate(), agentProfileVersion: 2 })).toThrow("version 8");
    expect(() => assertPiInstallationProfile({ ...candidate(), agentProfileVersion: 3 })).toThrow("version 8");
    expect(() => assertPiInstallationProfile({ ...candidate(), agentProfileVersion: 4 })).toThrow("version 8");
    expect(() => assertPiInstallationProfile({ ...candidate(), agentProfileVersion: 5 })).toThrow("version 8");
    expect(() => assertPiInstallationProfile({ ...candidate(), agentProfileVersion: 6 })).toThrow("version 8");
    expect(() => assertPiInstallationProfile({ ...candidate(), agentProfileVersion: 7 })).toThrow("version 8");
    for (const changed of [{ agentServerVersion: "latest" }, { commandDigest: `sha256:${"0".repeat(64)}` }, { reportedModelId: "different" }, { agentRuntimePackage: "ambient-pi" }]) {
      expect(() => assertPiInstallationProfile({ ...candidate(), ...changed })).toThrow("trusted declaration");
    }
  });
  it("never takes closure authority from installed metadata", async () => {
    const { assets } = await fixture();
    await writeFile(join(assets, "pi-distribution.json"), JSON.stringify({
      schema: "paperclip.pi-distribution.v1", runtimeRoot: "runtime", nativeClosureSha256: "0".repeat(64),
      target: { platform: process.platform, architecture: process.arch, nodeVersion: "24.21.0" },
      pins: { nodeVersion: "24.21.0", wrapper: "0.0.33", runtime: "0.84.2", sdk: "0.26.0", zod: "3.25.76" },
    }));
    await expect(verifyPiInstallation(candidate())).rejects.toThrow("trusted target pin");
  });
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

  it("refuses symlinked target assets and metadata", async () => {
    const { root, assets } = await fixture();
    await rm(assets, { recursive: true });
    await symlink(root, assets);
    await expect(verifyPiInstallation(candidate())).rejects.toThrow("fixed asset directory");
  });
});
