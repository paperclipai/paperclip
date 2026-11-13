// Exact native-only comparison boundary: executable fixtures stay byte-identical.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const NATIVE_COMPLETION_SOURCE_CONTRACT = {
  "schema": "paperclip.native-completion-source-contract.v1",
  "baseSha": "59c07ede72dc08b8aba149a01cc11e0b7a204621",
  "archiveSha": "9138f570c341c251a5727c32d6615ce238bc8e03",
  "shallowParentAnchors": {
    "candidate": "0a9c5a75164cd0b02115ff12273aadb6a86c9464",
    "historical": "00a761b967f9f73b0f45069c0ba828fae277a76e"
  },
  "variants": {
    "candidate": {
      "packages/paperclip-runner/src/contracts/completion-result.ts": "bd4bb79d2be5c4ee3765df67dfb4da98ef95bc532cac872be40cb41a6bff6cda",
      "packages/paperclip-runner/src/drivers/codex/codex-driver-values.ts": "aff3b3d2d626fbaf504a7e46adb27cb8127d0afbc62a8ed58111938f1293de7d",
      "packages/paperclip-runner/src/drivers/runner-tool-bridge.ts": "4cca0d7837e0f5a1f709abb0ba3982227288a01abd16a08107337416fde4a9e2",
      "packages/paperclip-runner/src/drivers/opencode/mcp-bridge.ts": "ec1cd94c17be22d0556d4586fa6407b28e2309ed7c2437d95a32beeb0755cc4f",
      "server/src/services/native-runtime/native-session-resume.ts": "5b27465e1a328412770fc27c4bc637e88b62022adc6a67709bb74187eadc465b",
      "packages/paperclip-runner/src/contracts/completion-result.test.ts": "42bd18105505da7fd7963311bf862002df7158f8c0cf2a81b927dff4c47ac500",
      "packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.lifecycle.test.ts": "2b15425514d8e3316baec48b8ce118394acf67d97b76cbab2a99916fc4e8e1d2",
      "packages/paperclip-runner/src/drivers/runner-tool-bridge.test.ts": "097d4973ac4ca200e82af31aece0f9d5531e1756ffe739d4422bd8f65d479232",
      "packages/paperclip-runner/src/drivers/opencode/mcp-bridge.test.ts": "533dd12ea00c61e012f5d596e03080fa1aaf63375ad7602c0de4e0a6c8370400",
      "packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts": "8546181e5b3a63a194ee9ea0fc99c2bd97562f0c105fffde298fa6d74b22e83b",
      "server/src/services/native-runtime/native-session-resume.test.ts": "57b498d76bc89801edc81d700cd87660a16074ae8bb8a43aa566205cc377d7b4"
    },
    "historical": {
      "packages/paperclip-runner/src/contracts/completion-result.ts": "00a684f9aea87f68eabf0974681c52461bc308631a1252a89c4ed087d7158b28",
      "packages/paperclip-runner/src/drivers/codex/codex-driver-values.ts": "87929dd81b6fdc44fb46e5b14ac775ca7244354587028b3bd356a617dcf31907",
      "packages/paperclip-runner/src/drivers/runner-tool-bridge.ts": "966696d39eb9554e5f40bd1d89d31efc426c3c01d2ce883b3b6e968db8480088",
      "packages/paperclip-runner/src/drivers/opencode/mcp-bridge.ts": "7080ae2896fe7a81fdf1a1c4f7fcd1773611cbd3336896b5f9e861c5b0aa0ed4",
      "server/src/services/native-runtime/native-session-resume.ts": "72b4f2e19c01a83ccd52e21102d2c5422265eec84b589ea75a7cffe40d1d0b8d",
      "packages/paperclip-runner/src/contracts/completion-result.test.ts": "7c615dc36ad07b7659c3605f94fec89ae592727ce078a62fa45eb1bb549f26d5",
      "packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.lifecycle.test.ts": "0b7e8b7a552d6a3d74d761e0e68b720ed02d621ded41a1c2076ca3fda0f96d0c",
      "packages/paperclip-runner/src/drivers/runner-tool-bridge.test.ts": "1ce59108e0cfef78fa71f0da9b46af70fd7bf3887d4a662556afc072d2351653",
      "packages/paperclip-runner/src/drivers/opencode/mcp-bridge.test.ts": "bb1b0447cca30f3a2984e9e832949108c43cefa35d765440d07ee8098be4ef0c",
      "packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts": "624bbac680e1dfc87fff9fab71501e8208e0bdbc6aefcb45a008b8e6c9030a27",
      "server/src/services/native-runtime/native-session-resume.test.ts": "ddd60db81cdb8d17a2b31ea934779687708b927f877f3fb6d0c249ceb805be62"
    }
  },
  "fixedContext": {
    "server/src/onboarding-assets/default/AGENTS.md": "e4d2375d722602cd744403292d99f6e6c9b7e8014d9cdfa6f9811ace03428e5f",
    "packages/adapter-utils/src/server-utils.ts": "916e879f70a90d31c89bc1486d5f84807c4ecafeab62961f67d84d1ebec7a173",
    "skills/paperclip/SKILL.md": "19b4e17bc6588b087efce63673c3f2839ac09dba9c072f56b8e90924a66856de",
    "server/src/services/onboarding-first-task-assets.ts": "c7fd1db7ed97850bd67e48a4d8c1470c8ff801f895f4f665b84690978f19b47e",
    "server/src/services/default-agent-instructions.ts": "8bd3b59f900c132db5ed89b96524f35ba7c8dafb9d58db1dac888430f08c4d63",
    "packages/paperclip-runner/src/contracts/runtime-context.ts": "a17e30a69f3cb38fba00c37e1a06753d723651a004e6050c9e77ae202a61264b",
    "packages/paperclip-runner/src/backends/runtime-context.ts": "e7c46e81cc9c93f9a4f805b5091ef08c59ea70c62f208cfda70d6edeed363898",
    "server/src/services/native-runtime/native-execution-input.ts": "e346bf3f163dfc5374c3c90fb515c1db6847bbab69fb59a49d73227478cef70d",
    "server/src/services/native-runtime/completion-contracts.ts": "b1f4f7a9b04fea902c23313adb296e67f202ee5878424f85a7d0cebcb775ab69",
    "server/src/services/native-runtime/runtime-context.ts": "13f71f749ad6a3a0612e3e268fdc2bc58ee26f70399dd120b1341abf00d1847b",
    "packages/paperclip-runner/src/drivers/codex/codex-app-server-driver-impl.ts": "1a3b80e9b155a1e7e1f72313ad41bb0a397d6d42cb6aedf23704c1cf9121c0b8"
  }
};
export const NATIVE_COMPLETION_FIXTURE_FILES = [
  "tests/runner-e2e/native-completion-cases.ts",
  "tests/runner-e2e/native-completion-scoring.ts",
  "tests/runner-e2e/native-completion-scoring.test.ts",
  "tests/runner-e2e/native-completion-defaults.ts",
  "tests/runner-e2e/native-completion-defaults.test.ts",
  "tests/runner-e2e/native-blocker-visible.ts",
  "tests/runner-e2e/native-blocker-visible.spec.ts",
  "tests/runner-e2e/native-completion-admission.ts",
  "tests/runner-e2e/native-completion-admission.test.ts",
  "tests/runner-e2e/native-completion-checks.mjs",
  "tests/runner-e2e/native-completion-checks.test.mjs",
  "tests/runner-e2e/native-completion-git-source.mjs",
  "tests/runner-e2e/native-completion-git-source.test.mjs",
  "tests/runner-e2e/fixtures/native-completion/terminal-tool-carrier.json",
  "tests/runner-e2e/native-completion-source-contract.mjs",
  "tests/runner-e2e/native-completion-source-contract.test.mjs",
  "tests/runner-e2e/automatic-retry.ts",
  "tests/runner-e2e/automatic-retry.test.ts",
  "tests/runner-e2e/launch.ts",
  "tests/runner-e2e/types.ts",
  "tests/runner-e2e/catalog.ts",
  "tests/runner-e2e/catalog.test.ts",
  "tests/runner-e2e/runner.spec.ts",
  "tests/runner-e2e/playwright-support.config.ts",
  "tests/runner-e2e/context-integrity-cases.ts",
  "tests/runner-e2e/context-integrity.test.ts",
  "tests/runner-e2e/context-integrity-evidence.test.ts",
  "tests/runner-e2e/context-integrity-flow-logs.test.ts",
  "tests/runner-e2e/live-fixtures.ts",
  "tests/runner-e2e/context-integrity-flow.ts",
  "tests/runner-e2e/context-integrity-scoring.ts",
  "tests/runner-e2e/selectors.ts",
  "tests/runner-e2e/harness-env.ts",
  "tests/runner-e2e/tsconfig.json",
  "tests/runner-e2e/vitest.config.ts"
];
export const NATIVE_COMPLETION_MANIFEST_FILES = [
  "packages/paperclip-runner/scripts/generate-capability-contract.mjs",
  "packages/paperclip-runner/scripts/check-capability-inventory.mjs",
  "packages/paperclip-runner/scripts/lib/capability-inventory.mjs",
  "packages/paperclip-runner/spec/capability/source-contract.json",
  "packages/paperclip-runner/spec/capability/capabilities.yaml",
  "packages/paperclip-runner/spec/capability/eval-traceability.yaml",
  "packages/paperclip-runner/spec/capability/mcp-tool-map.yaml",
  "packages/paperclip-runner/spec/capability/inventory.schema.json",
  "packages/paperclip-runner/src/generated/capability-contract.ts",
  "packages/paperclip-runner/docs/capability-contract.md",
  ...["capabilities.yaml", "mcp-tool-map.yaml", "eval-traceability.yaml", "capability-contract.md", "downstream-handoff.md"]
    .map(file => `packages/paperclip-runner/generated/capability/${file}`),
];
export const NATIVE_COMPLETION_SOURCE_FILES = [...new Set([
  ...Object.keys(NATIVE_COMPLETION_SOURCE_CONTRACT.variants.candidate),
  ...Object.keys(NATIVE_COMPLETION_SOURCE_CONTRACT.fixedContext),
  ...NATIVE_COMPLETION_FIXTURE_FILES, ...NATIVE_COMPLETION_MANIFEST_FILES,
  "scripts/ensure-plugin-build-deps.mjs",
  "packages/paperclip-runner/scripts/build-verified-provider-entrypoints.mjs",
  "packages/paperclip-runner/src/live/runnerd-codex-transport.ts",
  "packages/paperclip-runner/src/drivers/acpx/qualified-profiles.ts",
  "packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts",
  "packages/adapters/codex-local/src/index.ts", "packages/adapters/claude-local/src/index.ts",
  "packages/paperclip-runner/package.json", "tsconfig.base.json",
  "packages/paperclip-runner/runner/crates/runner-core/src/provider_events.rs",
  "packages/paperclip-runner/runner/Cargo.toml", "packages/paperclip-runner/runner/Cargo.lock",
  "packages/paperclip-runner/runner/crates/runner-core/Cargo.toml",
])].sort();

export const nativeSourceSha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function fingerprint(paths, read) {
  const hash = createHash("sha256");
  for (const file of [...paths].sort()) {
    const bytes = read(file);
    hash.update(JSON.stringify([file, bytes.length])).update(bytes);
  }
  return hash.digest("hex");
}

/** Infer a variant only from all eleven matching production/assertion files. */
export function nativeCompletionSourceFingerprint(read = file => readFileSync(join(
  resolve(import.meta.dirname, "../.."), file)), contract = NATIVE_COMPLETION_SOURCE_CONTRACT) {
  const observations = new Map(), sourceErrors = [];
  for (const file of NATIVE_COMPLETION_SOURCE_FILES) {
    try { observations.set(file, read(file)); } catch { sourceErrors.push(file); }
  }
  const matches = Object.entries(contract.variants).filter(([, expected]) => Object.entries(expected)
    .every(([file, digest]) => observations.has(file) && nativeSourceSha256(observations.get(file)) === digest));
  const variant = matches.length === 1 ? matches[0][0] : null;
  if (!variant) sourceErrors.push("native-completion: mixed or unknown production/assertion variant");
  for (const [file, digest] of Object.entries(contract.fixedContext))
    if (!observations.has(file) || nativeSourceSha256(observations.get(file)) !== digest)
      sourceErrors.push(`native-completion: changed master context ${file}`);
  const fromObservation = file => observations.get(file);
  const complete = NATIVE_COMPLETION_SOURCE_FILES.every(file => observations.has(file));
  return { variant, sourceErrors,
    fingerprint: complete ? fingerprint(NATIVE_COMPLETION_SOURCE_FILES, fromObservation) : null,
    fixtureFingerprint: complete ? fingerprint(NATIVE_COMPLETION_FIXTURE_FILES, fromObservation) : null,
    manifestFingerprint: complete ? fingerprint(NATIVE_COMPLETION_MANIFEST_FILES, fromObservation) : null,
    baseSha: contract.baseSha, archiveSha: contract.archiveSha,
  };
}
