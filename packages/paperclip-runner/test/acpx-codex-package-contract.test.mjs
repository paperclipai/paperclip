import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runnerPackage = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const rootPackage = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
);
const workspace = await readFile(
  new URL("../../../pnpm-workspace.yaml", import.meta.url),
  "utf8",
);
const acpxPatch = await readFile(
  new URL("../../../patches/acpx@0.13.1.patch", import.meta.url),
  "utf8",
);
const codexPatch = await readFile(
  new URL(
    "../../../patches/@agentclientprotocol__codex-acp@1.6.2.patch",
    import.meta.url,
  ),
  "utf8",
);
const claudePatch = await readFile(
  new URL(
    "../../../patches/@agentclientprotocol__claude-agent-acp@0.70.0.patch",
    import.meta.url,
  ),
  "utf8",
);
const qualifiedProfiles = await readFile(
  new URL("../src/drivers/acpx/qualified-profiles.ts", import.meta.url),
  "utf8",
);
const runnerdAcpxBackend = await readFile(
  new URL(
    "../runner/crates/runner-core/src/acpx_provider_backend.rs",
    import.meta.url,
  ),
  "utf8",
);
const providerPackBuilder = await readFile(
  new URL("../scripts/build-provider-pack.mjs", import.meta.url),
  "utf8",
);
const nativeSessionExecutor = await readFile(
  new URL(
    "../../../server/src/services/native-runtime/native-session-executor.ts",
    import.meta.url,
  ),
  "utf8",
);

test("the runner pins every qualified ACPX production dependency", () => {
  assert.equal(runnerPackage.dependencies["@openai/codex"], undefined);
  assert.equal(runnerPackage.optionalDependencies, undefined);
  assert.equal(runnerPackage.dependencies.node, undefined);
  assert.equal(runnerPackage.dependencies.acpx, "0.13.1");
  assert.equal(
    runnerPackage.dependencies["@agentclientprotocol/codex-acp"],
    "1.6.2",
  );
  assert.equal(
    runnerPackage.dependencies["@agentclientprotocol/claude-agent-acp"],
    "0.70.0",
  );
});

test("the patched Codex ACP command digest stays aligned across launch boundaries", () => {
  const profileMatch =
    /agent: "codex"[\s\S]*?commandDigest:\s*"(sha256:[a-f0-9]{64})"/.exec(
      qualifiedProfiles,
    );
  assert.ok(profileMatch, "qualified Codex ACPX profile digest");
  const digest = profileMatch[1];

  assert.match(runnerdAcpxBackend, new RegExp(`"codex"[\\s\\S]*?${digest}`));
  assert.match(
    providerPackBuilder,
    new RegExp(`acpxProfileDigests:[\\s\\S]*?codex:[\\s\\S]*?${digest}`),
  );
  assert.match(
    nativeSessionExecutor,
    new RegExp(
      `REMOTE_PROVIDER_PACK_PROFILE_DIGESTS[\\s\\S]*?codex:[\\s\\S]*?${digest}`,
    ),
  );
});

test("the package exposes only the reviewed runner CLI binaries", () => {
  assert.deepEqual(runnerPackage.bin, {
    "paperclip-runner-eval-session": "./dist/cli/eval-session.js",
    "paperclip-runner-codex-proxy": "./dist/cli/codex-app-server-unix-proxy.js",
    "paperclip-runner-acpx-sidecar": "./dist/cli/acpx-runtime-sidecar.js",
    "paperclip-runner-opencode-proxy":
      "./dist/cli/opencode-app-server-proxy.js",
  });
});

test("old and new pnpm configuration both apply the exact runtime patches", () => {
  assert.equal(
    rootPackage.pnpm.patchedDependencies["acpx@0.13.1"],
    "patches/acpx@0.13.1.patch",
  );
  assert.equal(
    rootPackage.pnpm.patchedDependencies[
      "@agentclientprotocol/claude-agent-acp@0.70.0"
    ],
    "patches/@agentclientprotocol__claude-agent-acp@0.70.0.patch",
  );
  assert.equal(
    rootPackage.pnpm.patchedDependencies[
      "@agentclientprotocol/codex-acp@1.6.2"
    ],
    "patches/@agentclientprotocol__codex-acp@1.6.2.patch",
  );
  assert.match(workspace, /acpx@0\.13\.1: patches\/acpx@0\.13\.1\.patch/);
  assert.match(
    workspace,
    /codex-acp@1\.6\.2["']: patches\/@agentclientprotocol__codex-acp@1\.6\.2\.patch/,
  );
  assert.match(
    workspace,
    /claude-agent-acp@0\.70\.0["']: patches\/@agentclientprotocol__claude-agent-acp@0\.70\.0\.patch/,
  );
  assert.equal(rootPackage.pnpm.patchedDependencies["node@24.11.0"], undefined);
  assert.doesNotMatch(workspace, /node@24\.11\.0:/);
  assert.match(
    providerPackBuilder,
    /copyFileSync\(process\.execPath, stableNodeCommand\)/,
  );
  assert.match(codexPatch, /\+    "@openai\/codex": "0\.148\.0"/);
});

test("the ACPX patch preserves launch-only state and verified spawning", () => {
  for (const token of [
    "spawnEnvironment",
    "spawnCwd",
    "spawnAgent",
    "SpawnOptionsWithoutStdio",
    "this.options.spawnAgent",
  ]) {
    assert.match(acpxPatch, new RegExp(token));
  }
});

test("the ACPX patch fails closed on an invalid spawn environment", () => {
  for (const token of [
    "isPlainStringEnvironment",
    "Object.getPrototypeOf(value)",
    'Object.values(value).every((entry) => typeof entry === "string")',
    "spawnEnvironment !== void 0",
    "sourceEnvironment = spawnEnvironment()",
    "ACPX spawn environment must be a plain record of string values",
  ]) {
    assert.match(
      acpxPatch,
      new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.doesNotMatch(acpxPatch, /spawnEnvironment\?\.\(\)/);
  assert.doesNotMatch(
    acpxPatch,
    /spawnEnvironment \? \{ \.\.\.spawnEnvironment \} : \{ \.\.\.process\.env \}/,
  );
});

test("the Codex patch enforces isolated instructions, tools, and skills", () => {
  for (const token of [
    "PAPERCLIP_ACPX_ISOLATED_CONTEXT",
    "baseInstructions",
    "rawInput: { serverName: params.serverName }",
    '"features.apps": false',
    "process.env.CODEX_HOME",
  ]) {
    assert.match(
      codexPatch,
      new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("the Codex patch keeps MCP tool approvals on the governed permission channel", () => {
  assert.match(
    codexPatch,
    /!context\.isToolApproval && this\.shouldUseAcpElicitation\(params\)/,
  );
});

test("the Claude patch removes ambient project and local configuration", () => {
  for (const token of [
    "PAPERCLIP_ACPX_ISOLATED_CONTEXT",
    'settingSources: ["user"]',
    "userProvidedOptions?.mcpServers",
  ]) {
    assert.match(
      claudePatch,
      new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});
