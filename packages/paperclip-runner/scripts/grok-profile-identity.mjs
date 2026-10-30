import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
// Versions 1–14 remain decodable historical identities. Versioned fixtures are
// immutable; advance this version before changing a versioned declaration.
export const GROK_PROFILE_VERSION = 15;
// Contract surfaces: ACPX wire patch; sidecar parsing and error translation;
// native effort/search/credential admission; host/sandbox/tool-bridge execution;
// launcher integrity and platform pins; Rust descriptor writes, session state,
// and transport classification. This is an explicit boundary list, not the
// sidecar's complete import graph.
export const GROK_PROFILE_SOURCE_FILES = [
  "patches/acpx@0.13.1.patch",
  ...[
    "src/cli/acpx-runtime-sidecar.ts", "src/cli/acpx-sidecar-input.ts",
    "src/drivers/acpx/admission-diagnostics.ts", "src/drivers/acpx/grok-effort.ts",
    "src/drivers/acpx/grok-web-search.ts", "src/drivers/acpx/grok-credentials.ts",
    "src/drivers/acpx/codex-runtime-adapter.ts", "src/drivers/acpx/runtime-host.ts",
    "src/drivers/preconfigured-home.ts",
    "src/drivers/acpx/runtime-sandbox.ts", "src/drivers/acpx/sidecar-protocol.ts",
    // The sidecar's session.open allowlist, generated from the sidecar schema.
    "src/drivers/acpx/generated-sidecar-contract.ts",
    "src/drivers/acpx/native-distribution-integrity.ts",
    "src/providers/grok/launcher.cjs", "src/providers/grok/platforms.json",
    "runner/crates/runner-core/src/acpx_provider_backend.rs",
    "runner/crates/runner-core/src/acpx_provider_session.rs",
    "runner/crates/runner-core/src/acpx_sidecar_transport.rs",
  ].map(path => `packages/paperclip-runner/${path}`),
];
const canonical = value => value && typeof value === "object"
  ? Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const launcherPath = "packages/paperclip-runner/src/providers/grok/launcher.cjs";
const launcherBody = root => readFileSync(resolve(root, launcherPath), "utf8")
  .replace(/^\/\/ Grok admission source identity: sha256:[a-f0-9]{64}\r?\n/u, "");
const stampedLauncher = (root, sourceDigest) => `// Grok admission source identity: ${sourceDigest}\n${launcherBody(root)}`;

export function grokProfileIdentity(root = repositoryRoot) {
  const manifest = JSON.parse(readFileSync(resolve(root, "packages/paperclip-runner/acpx-profiles.json"), "utf8"));
  const { commandDigest: _digest, ...profile } = manifest.profiles.grok;
  const declaration = {
    schema: "paperclip.grok-profile-identity.v1", agent: "grok",
    ...profile, agentProfileVersion: GROK_PROFILE_VERSION, acpxVersion: manifest.acpxVersion,
    sources: Object.fromEntries(GROK_PROFILE_SOURCE_FILES.map(path => [path,
      sha(path === launcherPath ? launcherBody(root) : readFileSync(resolve(root, path)))])),
  };
  const sourceDigest = sha(canonical(declaration));
  // Preserve the command's physical byte-digest contract. The source stamp
  // changes those bytes when the Grok admission implementation changes.
  return { commandDigest: sha(stampedLauncher(root, sourceDigest)), sourceDigest, declaration };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = grokProfileIdentity();
  const manifestPath = resolve(packageRoot, "acpx-profiles.json");
  const fixturePath = resolve(packageRoot, `test/fixtures/grok-profile-v${GROK_PROFILE_VERSION}-identity.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (process.argv.includes("--check")) {
    assert.deepEqual(JSON.parse(readFileSync(fixturePath, "utf8")), identity, "Grok source identity is stale");
    assert.equal(manifest.profiles.grok.commandDigest, identity.commandDigest);
    assert.equal(manifest.profiles.grok.agentProfileVersion, GROK_PROFILE_VERSION);
    assert.equal(readFileSync(resolve(repositoryRoot, launcherPath), "utf8"), stampedLauncher(repositoryRoot, identity.sourceDigest));
  } else {
    if (existsSync(fixturePath) && canonical(JSON.parse(readFileSync(fixturePath, "utf8"))) !== canonical(identity)) {
      throw new Error(`Grok profile ${GROK_PROFILE_VERSION} identity is immutable; advance GROK_PROFILE_VERSION before changing bound source`);
    }
    writeFileSync(resolve(repositoryRoot, launcherPath), stampedLauncher(repositoryRoot, identity.sourceDigest));
    manifest.profiles.grok.commandDigest = identity.commandDigest;
    manifest.profiles.grok.agentProfileVersion = GROK_PROFILE_VERSION;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(fixturePath, `${JSON.stringify(identity, null, 2)}\n`);
  }
  execFileSync(process.execPath, [resolve(packageRoot, "scripts/generate-acpx-profiles.mjs"),
    ...(process.argv.includes("--check") ? ["--check"] : [])], { stdio: "inherit" });
  console.log(identity.commandDigest);
}
