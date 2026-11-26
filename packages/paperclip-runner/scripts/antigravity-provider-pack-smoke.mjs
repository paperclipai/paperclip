import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const ANTIGRAVITY_SMOKE_MODEL = "gemini-3.8-flash-low";
const SMOKE_INSTRUCTIONS = "Paperclip installed-package smoke: no prompt is sent.\n";

/** Exactly one inventory carries Antigravity: candidates while pending, providers after the flip. */
export function assertAntigravityProviderPackInventory(manifest, profile, pins, platform = process.platform, architecture = process.arch) {
  assert.equal(manifest.schema, "paperclip-runner/remote-provider-pack/v1");
  assert.deepEqual(manifest.payload.target, { platform, architecture });
  const target = `${platform}-${architecture}`;
  assert.equal(target, "linux-x64", "Antigravity provider packs target only linux-x64");
  const pending = profile.qualificationStatus === "pending";
  const identity = pending ? manifest.payload.candidateProviders?.antigravity : manifest.payload.providers?.antigravity;
  assert.equal(pending ? manifest.payload.providers?.antigravity : manifest.payload.candidateProviders?.antigravity, undefined,
    "Antigravity must not appear in both pack inventories");
  assert.ok(identity, "Antigravity is missing from the pack inventory its release state requires");
  assert.deepEqual(Object.keys(identity).sort(), ["closureDigest", "path", "profileDigest", "qualification", "sha256", "version"]);
  assert.equal(identity.qualification, pending ? "pending" : "qualified");
  assert.equal(identity.version, profile.agentServerVersion);
  assert.equal(identity.path, `provider-assets/antigravity/${target}`);
  assert.equal(identity.profileDigest, profile.commandDigest);
  assert.match(pins[target]?.closureSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(identity.closureDigest, `sha256:${pins[target].closureSha256}`);
  assert.match(identity.sha256, /^sha256:[a-f0-9]{64}$/);
  return identity;
}

/**
 * Launches the packaged closure through the Runner's own installation verifier
 * and private launch snapshot. Without `apiKey` it is credential-free: only
 * `initialize`. With `apiKey` it also opens one API-key session and checks the
 * exact-model native admission receipt. It never sends a prompt.
 */
export async function smokeAntigravityProviderPack(directory, { apiKey, model = ANTIGRAVITY_SMOKE_MODEL } = {}) {
  const started = performance.now();
  const elapsed = from => Math.round(performance.now() - from);
  const pack = await realpath(resolve(directory));
  const manifest = JSON.parse(await readFile(join(pack, "provider-pack.json"), "utf8"));
  assert.equal(manifest.payload.target.platform, process.platform);
  assert.equal(manifest.payload.target.architecture, process.arch);
  if (process.env.PAPERCLIP_EXPECTED_SOURCE_REVISION) assert.equal(manifest.payload.runnerSourceRevision, process.env.PAPERCLIP_EXPECTED_SOURCE_REVISION);
  const load = path => import(pathToFileURL(join(pack, "dist/drivers/acpx", path)));
  const [{ verifyAntigravityInstallation }, { QUALIFIED_ACPX_PROFILES, resolveQualifiedAcpxProfile }, { ANTIGRAVITY_DISTRIBUTION_PINS, ANTIGRAVITY_RUNTIME_VERSION },
    { bindAcpxCandidateAdmission }, { antigravityPrivateEnvironment, retireAntigravityProcess }, { createAntigravityAdmission }] = await Promise.all([
    load("antigravity-installation.js"), load("qualified-profiles.js"), load("generated-profiles.js"),
    load("candidate-admission.js"), load("antigravity-process.js"), load("antigravity-admission.js"),
  ]);
  const release = QUALIFIED_ACPX_PROFILES.antigravity;
  const provider = assertAntigravityProviderPackInventory(manifest, release, ANTIGRAVITY_DISTRIBUTION_PINS);
  const profile = resolveQualifiedAcpxProfile("antigravity", model);
  const target = `${process.platform}-${process.arch}`;
  const admission = release.qualificationStatus === "pending" ? bindAcpxCandidateAdmission({
    schema: "paperclip.acpx-candidate-admission.v1", companyId: "provider-pack-smoke", agent: "antigravity", model,
    profileDigest: release.commandDigest, nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS[target].closureSha256}`,
    platform: process.platform, architecture: process.arch, expiresAt: Date.now() + 10 * 60_000,
  }, { runId: "provider-pack-smoke", normalizedSessionId: "provider-pack-smoke" }) : undefined;
  const keys = ["PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST"];
  const previous = keys.map(key => process.env[key]);
  process.env[keys[0]] = pack; process.env[keys[1]] = join(pack, "package.json");
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-pack-smoke-")));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  const timings = {};
  let lease, child, closed;
  try {
    let phase = performance.now();
    const installation = await verifyAntigravityInstallation(profile, admission);
    timings.verifyMs = elapsed(phase);
    phase = performance.now();
    lease = await installation.openCommand();
    timings.launchSnapshotMs = elapsed(phase);
    const env = await antigravityPrivateEnvironment(home);
    if (apiKey) {
      await mkdir(join(home, "antigravity-acp"), { mode: 0o700 });
      await writeFile(join(home, "antigravity-acp", "settings.json"), `${JSON.stringify({ auth: { type: "gemini-api-key" } })}\n`, { mode: 0o600 });
      env.GEMINI_API_KEY = apiKey;
    }
    const guard = createAntigravityAdmission(SMOKE_INSTRUCTIONS, model).createGuard();
    phase = performance.now();
    child = lease.spawn([], { cwd: workspace, stdio: "pipe", env });
    closed = once(child, "close").then(() => undefined);
    const pending = new Map();
    let buffer = "", bytes = 0, sequence = 0;
    const fail = error => { for (const request of pending.values()) request.reject(error); pending.clear(); };
    child.on("error", fail); child.on("close", () => fail(new Error("Antigravity exited with a pending ACP request")));
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { fail(new Error("Antigravity ACP output exceeded its package smoke bound")); return; }
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); guard("inbound", value); } catch (error) { fail(error instanceof SyntaxError ? new Error("Antigravity emitted malformed ACP JSON") : error); return; }
        const request = pending.get(value.id);
        if (request && value.method === undefined) {
          pending.delete(value.id);
          if (value.error) request.reject(new Error(`Antigravity rejected ACP request (${value.error.code})`));
          else request.resolve(value.result);
        }
      }
    });
    const request = (method, params, timeoutMs) => new Promise((accept, reject) => {
      const id = sequence++;
      const message = { jsonrpc: "2.0", id, method, params };
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Antigravity ${method} timed out`)); }, timeoutMs);
      const settle = callback => value => { clearTimeout(timeout); callback(value); };
      pending.set(id, { resolve: settle(accept), reject: settle(reject) });
      try { guard("outbound", message); } catch (error) { pending.delete(id); clearTimeout(timeout); reject(error); return; }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
    const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "paperclip-provider-pack-smoke", version: "1" } }, 60_000);
    timings.initializeMs = elapsed(phase);
    assert.equal(initialized.agentInfo?.name, "antigravity-acp");
    assert.equal(initialized.agentInfo?.version, ANTIGRAVITY_RUNTIME_VERSION);
    assert.equal(initialized.agentInfo.version, provider.version);
    assert.equal(initialized.agentCapabilities?._meta?.antigravity?.paperclipAdmission, 1);
    assert.equal(initialized.agentCapabilities._meta.antigravity.paperclipModels, 1);
    let session = null;
    if (apiKey) {
      phase = performance.now();
      const created = await request("session/new", { cwd: workspace, mcpServers: [] }, 90_000);
      timings.sessionNewMs = elapsed(phase);
      const receipt = created._meta?.paperclipAntigravityAdmission;
      // The guard already rejected a missing, stale or different-model receipt.
      assert.equal(receipt?.model, model);
      assert.equal(receipt.sessionId, created.sessionId);
      session = { authMethod: "gemini-api-key", model: receipt.model, receiptSchema: receipt.schema, receiptMatched: true };
    }
    phase = performance.now();
    await retireAntigravityProcess(child, closed);
    child = undefined;
    await lease.close();
    lease = undefined;
    timings.closeMs = elapsed(phase);
    timings.totalMs = elapsed(started);
    return { schema: "paperclip.antigravity-provider-pack-smoke.v1", sourceRevision: manifest.payload.runnerSourceRevision, providerPackDigest: manifest.digest,
      platform: process.platform, architecture: process.arch, runtimeVersion: initialized.agentInfo.version, qualification: provider.qualification,
      profileDigest: provider.profileDigest, closureDigest: provider.closureDigest, paperclipAdmission: 1, session, timings,
      providerPrompts: 0, providerCredentials: Boolean(apiKey) };
  } finally {
    try {
      if (child) await retireAntigravityProcess(child, closed).catch(() => undefined);
      if (lease) await lease.close().catch(() => undefined);
    } finally {
      keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
      await rm(root, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, mode] = process.argv.slice(2);
  if (!directory || process.argv.length > 4 || (mode !== undefined && mode !== "--session")) {
    throw new Error("Usage: node scripts/antigravity-provider-pack-smoke.mjs /absolute/installed-provider-pack [--session]  (--session reads GEMINI_API_KEY)");
  }
  if (mode && !process.env.GEMINI_API_KEY) throw new Error("--session requires GEMINI_API_KEY");
  smokeAntigravityProviderPack(directory, { apiKey: mode ? process.env.GEMINI_API_KEY : undefined, model: process.env.PAPERCLIP_ANTIGRAVITY_SMOKE_MODEL || undefined })
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
