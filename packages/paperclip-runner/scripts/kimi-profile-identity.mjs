import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const KIMI_PROFILE_VERSION = 16;
const sources = [
  "scripts/patch-kimi-runtime.mjs", "scripts/kimi-instructions-runtime.mjs",
  "scripts/materialize-kimi-distribution.mjs", "scripts/provision-kimi.mjs",
  "scripts/kimi-distribution/package.json", "scripts/kimi-distribution/package-lock.json",
  "src/drivers/acpx/kimi-closure-pins.ts", "src/drivers/acpx/kimi-config.ts",
  "src/drivers/acpx/kimi-installation.ts", "src/drivers/acpx/kimi-instructions.ts",
  "src/drivers/acpx/session-context-admission.ts", "src/drivers/acpx/kimi-runtime-files.ts",
  "src/configured-environment.ts", "src/drivers/acpx/environment.ts",
  "src/drivers/acpx/codex-runtime-adapter.ts", "src/drivers/acpx/runtime-host.ts",
  "src/drivers/acpx/runtime-sandbox.ts", "src/cli/acpx-runtime-sidecar.ts",
  "scripts/build-verified-provider-entrypoints.mjs",
  "src/drivers/acpx/kimi-models.ts", "src/drivers/acpx/kimi-metadata-probe.ts",
  "src/cli/kimi-metadata-probe.ts", "src/drivers/acpx/kimi-message-boundary.ts",
  "src/drivers/acpx/codex-acpx-driver.ts", "src/drivers/acpx/sidecar-protocol.ts",
  "src/drivers/acpx/acp-edit-context.ts", "src/drivers/acpx/acp-permission-adapter.ts",
  "src/drivers/acpx/safe-locations.ts", "src/drivers/acpx/generated-sidecar-contract.ts",
  "src/semantic-tools/redaction.ts",
  "runner/crates/runner-core/src/acpx_provider_state.rs",
  "src/drivers/acpx/candidate-admission.ts",
  "src/drivers/acpx/qualified-profiles.ts",
  "src/drivers/acpx/profile-installation.ts",
  "src/drivers/acpx/driver-profile.ts",
  "src/live/runnerd-codex-transport.ts",
  "runner/crates/runner-core/src/acpx_candidate_admission.rs",
  "runner/crates/runner-core/src/acpx_provider_backend.rs",
  "runner/crates/runner-core/src/acpx_provider_session.rs",
  "runner/crates/runner-core/src/acpx_sidecar_transport.rs",
  "runner/crates/runner-core/src/native_provider_backend.rs",
  "runner/crates/runner-core/src/durable/runner.rs",
  "runner/crates/runner-core/src/durable/mod.rs",
  "src/contracts/runtime-context.ts",
  "src/contracts/generated-runtime-context-contract.ts",
  "src/contracts/runtime-context-prompts.ts",
  "src/provider-events.ts",
  "src/native-session-runtime.ts",
  "src/control-plane/durable-prp-control-plane.ts",
  "src/drivers/codex/codex-harness-session.ts",
  "src/drivers/codex/codex-session-notifications.ts",
  "src/drivers/codex/codex-session-state.ts",
  "runner/crates/runner-core/src/provider_backend.rs",
  "runner/crates/runner-core/src/provider_bridge.rs",
  "runner/crates/runner-core/src/provider_events.rs",
  "runner/crates/runner-core/src/acpx_event_scope.rs",
  "runner/crates/runner-core/src/acpx_event_payload.rs",
  "scripts/generate-acpx-profiles.mjs",
];
const canonical = value => value && typeof value === "object"
  ? Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const sha = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function kimiProfileIdentity(root = packageRoot) {
  const manifest = JSON.parse(readFileSync(resolve(root, "acpx-profiles.json"), "utf8"));
  const { commandDigest: _digest, ...profile } = manifest.profiles.kimi;
  const declaration = {
    schema: "paperclip.kimi-profile-identity.v1", agent: "kimi", ...profile,
    agentProfileVersion: KIMI_PROFILE_VERSION, acpxVersion: manifest.acpxVersion,
    sources: Object.fromEntries(sources.map(path => [path, sha(readFileSync(resolve(root, path)))])),
  };
  return { declaration, commandDigest: sha(canonical(declaration)) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = kimiProfileIdentity();
  const manifestPath = resolve(packageRoot, "acpx-profiles.json");
  const fixturePath = resolve(packageRoot, `test/fixtures/kimi-profile-v${KIMI_PROFILE_VERSION}-identity.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (process.argv.includes("--check")) {
    assert.deepEqual(JSON.parse(readFileSync(fixturePath, "utf8")), identity, "Kimi source identity is stale");
    assert.equal(manifest.profiles.kimi.commandDigest, identity.commandDigest);
    assert.equal(manifest.profiles.kimi.agentProfileVersion, KIMI_PROFILE_VERSION);
  } else {
    if (existsSync(fixturePath) && canonical(JSON.parse(readFileSync(fixturePath, "utf8"))) !== canonical(identity)) throw new Error("Kimi profile identity is immutable; advance KIMI_PROFILE_VERSION before changing its bound source");
    manifest.profiles.kimi.commandDigest = identity.commandDigest;
    manifest.profiles.kimi.agentProfileVersion = KIMI_PROFILE_VERSION;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(fixturePath, `${JSON.stringify(identity, null, 2)}\n`);
  }
}
