import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withCopilotSmokeResources } from "./copilot-smoke-resources.mjs";

// Build verification only. No prompt, credential, model request, or runtime
// installation occurs; the provider runs offline with isolated state.
const pack = await realpath(resolve(process.argv[2] ?? "provider-pack"));
const manifest = JSON.parse(await readFile(join(pack, "provider-pack.json"), "utf8"));
// Bind the audited pack explicitly, just as the verified sidecar launcher does.
process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT = pack;
process.env.PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST = join(pack, "package.json");
const candidate = manifest.payload.candidateProviders?.copilot;
assert.equal(candidate?.version, "1.0.88");
assert.equal(candidate.qualification, "pending");
const { assertAcpxProfileEnvironment, verifyAcpxProfileInstallation } = await import(pathToFileURL(join(pack, "dist/drivers/acpx/profile-installation.js")));
const { resolveQualifiedAcpxProfile } = await import(pathToFileURL(join(pack, "dist/drivers/acpx/qualified-profiles.js")));
const { COPILOT_ACP_CLIENT_CAPABILITIES } = await import(pathToFileURL(join(pack, "dist/drivers/acpx/copilot-events.js")));
// This explicit value exercises profile admission only; no model is selected
// or used by initialize, and this is not a claim of model availability.
const profile = resolveQualifiedAcpxProfile("copilot", "gpt-4.1");
assert.throws(() => assertAcpxProfileEnvironment("copilot", {}), { code: "COPILOT_AUTH_REQUIRED" });
const installation = await verifyAcpxProfileInstallation(profile);
assert.equal(installation.commandDigest, candidate.profileDigest);
await withCopilotSmokeResources(installation, async ({ lease, root, fixture, fixtureRequests }) => {
  let child;
  let exited;
  try {
    const environment = { PATH: "/usr/bin:/bin", COPILOT_OFFLINE: "true", COPILOT_AUTO_UPDATE: "false", NO_COLOR: "1",
      COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${fixture.address().port}`, COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_MODEL_ID: "gpt-4.1", COPILOT_MODEL: "gpt-4.1",
    };
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "COPILOT_HOME", "COPILOT_CACHE_HOME"]) {
      environment[name] = join(root, name.toLowerCase());
      await mkdir(environment[name], { mode: 0o700 });
    }
    await writeFile(join(environment.COPILOT_HOME, "config.json"), JSON.stringify({ autoUpdate: false, trustedFolders: [], disableAllHooks: true, memory: false, ide: { autoConnect: false } }), { mode: 0o600 });
    child = lease.spawn([], { cwd: root, env: environment, stdio: "pipe" });
    exited = once(child, "exit");
    const initialized = new Promise((done, reject) => {
      let buffer = "";
      let stderr = "";
      let total = 0;
      const timeout = setTimeout(() => reject(new Error(`Copilot ACP initialize timed out: ${stderr.replaceAll(root, "/fixture/workspace").replaceAll(pack, "/fixture/provider-pack").slice(0, 4000)}`)), 20_000);
      timeout.unref();
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Copilot exited before initialize: ${stderr.replaceAll(root, "/fixture/workspace").replaceAll(pack, "/fixture/provider-pack").slice(0, 4000)}`)));
      child.stdout.on("data", chunk => {
        total += chunk.length;
        if (total > 1024 * 1024) { reject(new Error("Copilot ACP output exceeded bound")); return; }
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n");
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let response;
          try { response = JSON.parse(line); } catch { reject(new Error("Copilot emitted malformed ACP JSON")); return; }
          if (response.id === 0 && response.method === undefined) {
            clearTimeout(timeout);
            if (response.error || !response.result) reject(new Error("Copilot rejected ACP initialize"));
            else done(response.result);
          }
        }
      });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "paperclip-pack-offline-smoke", version: "1" }, clientCapabilities: COPILOT_ACP_CLIENT_CAPABILITIES } })}\n`);
    const result = await initialized;
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentInfo?.version, "1.0.88");
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 1_000);
    const [exitCode, signal] = await within(exited, 10_000);
    clearTimeout(timer);
    assert.equal(exitCode, 0, "Copilot did not exit cleanly after stdin EOF");
    assert.equal(signal, null);
    assert.equal(fixtureRequests.some(request => request.method !== "GET"), false, "Unexpected model inference request");
    const safeInitialize = JSON.parse(JSON.stringify(result, (key, value) =>
      key === "command" && typeof value === "string" && value.endsWith("/distribution/copilot") ? "/fixture/verified/copilot" : value));
    const executable = await readFile(join(pack, candidate.path, "copilot"));
    process.stdout.write(`${JSON.stringify({
      schema: "paperclip.copilot-provider-pack-smoke/v1", sourceRevision: manifest.payload.runnerSourceRevision,
      providerPackDigest: manifest.digest, platform: process.platform, architecture: process.arch,
      candidate, executableSha256: `sha256:${createHash("sha256").update(executable).digest("hex")}`,
      registryLaunch: "verifyAcpxProfileInstallation/openCommand/spawn", initializeRequestId: 0,
      initialize: safeInitialize, missingCredentialPreflight: "COPILOT_AUTH_REQUIRED", cleanExit: true, inheritedCredentials: false, promptSent: false,
      networkMode: "COPILOT_OFFLINE=true; loopback metadata-only provider", fixtureRequests, protocolFixtureModel: "gpt-4.1 (not a qualified GitHub model)", costUsd: 0,
      qualification: "pending: no credential, entitlement, model execution or Daytona",
    }, null, 2)}\n`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill("SIGTERM");
      await within(exited, 5_000);
    }
  }
});


async function within(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Copilot smoke cleanup was not confirmed")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
