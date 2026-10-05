import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
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
    "../../../patches/@agentclientprotocol__claude-agent-acp@0.85.1.patch",
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
  assert.equal(runnerPackage.dependencies["@openai/codex"], "0.156.0");
  assert.equal(runnerPackage.dependencies["@anthropic-ai/claude-agent-sdk"], undefined);
  assert.equal(rootPackage.pnpm.overrides["@agentclientprotocol/codex-acp@1.6.2>@openai/codex"], runnerPackage.dependencies["@openai/codex"]);
  assert.equal(rootPackage.pnpm.overrides["@agentclientprotocol/claude-agent-acp@0.85.1>@anthropic-ai/claude-agent-sdk"], "0.3.286");
  assert.equal(runnerPackage.optionalDependencies, undefined);
  assert.equal(runnerPackage.dependencies.node, undefined);
  assert.equal(runnerPackage.dependencies.acpx, "0.13.1");
  assert.equal(
    runnerPackage.dependencies["@agentclientprotocol/codex-acp"],
    "1.6.2",
  );
  assert.equal(
    runnerPackage.dependencies["@agentclientprotocol/claude-agent-acp"],
    "0.85.1",
  );
});

test("the patched Codex ACP executable digest stays aligned across launch boundaries", async () => {
  const profileMatch =
    /agent: "codex"[\s\S]*?commandDigest:\s*"(sha256:[a-f0-9]{64})"/.exec(
      qualifiedProfiles,
    );
  assert.ok(profileMatch, "qualified Codex ACPX profile digest");
  const digest = profileMatch[1];
  const packagePath = createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp/package.json");
  const installed = JSON.parse(await readFile(packagePath, "utf8"));
  const executable = await readFile(resolve(dirname(packagePath), installed.bin["codex-acp"]));
  assert.equal(digest, `sha256:${createHash("sha256").update(executable).digest("hex")}`,
    "the identity binds installed executable bytes, not the patch file");

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
      "@agentclientprotocol/claude-agent-acp@0.85.1"
    ],
    "patches/@agentclientprotocol__claude-agent-acp@0.85.1.patch",
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
    /claude-agent-acp@0\.85\.1["']: patches\/@agentclientprotocol__claude-agent-acp@0\.85\.1\.patch/,
  );
  assert.equal(rootPackage.pnpm.patchedDependencies["node@24.11.0"], undefined);
  assert.doesNotMatch(workspace, /node@24\.11\.0:/);
  assert.match(
    providerPackBuilder,
    /copyFileSync\(process\.execPath, stableNodeCommand\)/,
  );
  assert.match(codexPatch, /\+    "@openai\/codex": "0\.156\.0"/);
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

test("authentication rejects invalid isolated environments without host fallback", () => {
  const addedSource = acpxPatch.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1)).join("\n");
  const start = addedSource.indexOf("function isPlainStringEnvironment(value)");
  const end = addedSource.indexOf("function buildAgentEnvironment(", start);
  assert.ok(start >= 0 && end > start);
  const hostEnvironment = { XAI_API_KEY: "host-credential-must-not-leak" };
  const resolveEnvironment = new Function(
    "process", `${addedSource.slice(start, end)}; return resolveAgentEnvironment;`,
  )({ env: hostEnvironment });
  for (const invalid of [undefined, null, [], "invalid", { XAI_API_KEY: 1 }]) {
    assert.throws(() => resolveEnvironment(() => invalid), TypeError);
  }
  const isolated = {};
  assert.equal(resolveEnvironment(() => isolated), isolated);
  assert.equal(resolveEnvironment(() => isolated).XAI_API_KEY, undefined);
  assert.equal(resolveEnvironment(undefined), hostEnvironment);
  assert.match(addedSource, /readEnvCredential\(method\.id, resolveAgentEnvironment\(this\.options\.spawnEnvironment\)\)/);
  assert.match(addedSource, /resolveAgentEnvironment\(this\.options\.spawnEnvironment\)\)\.XAI_API_KEY/);
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

// The test above only greps the patch *file text*. A fuzzy or partial
// `patch -p1` application (see doc/plans/2026-10-03-claude-agent-acp-0.85.1-patch-report.md)
// can leave the patch file untouched while the installed artifact only
// gets some of the hunks — this test instead resolves and asserts against
// the artifact pnpm actually installs, which is what the runner spawns.
test("the installed Claude ACP artifact actually carries the isolation gates", async () => {
  const packagePath = createRequire(import.meta.url).resolve(
    "@agentclientprotocol/claude-agent-acp/package.json",
  );
  const installed = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(installed.version, "0.85.1");
  const agentSource = await readFile(
    resolve(dirname(packagePath), installed.bin["claude-agent-acp"].replace("index.js", "acp-agent.js")),
    "utf8",
  );

  const queryCallSites = agentSource.match(/\bquery\(\{/g) ?? [];
  assert.equal(
    queryCallSites.length,
    1,
    "expected exactly one query({ call site; upstream added a second entry path that needs review",
  );

  const createSessionStart = agentSource.indexOf("async createSession(params, creationOpts = {})");
  assert.ok(createSessionStart >= 0, "createSession method");
  const queryCallIndex = agentSource.indexOf("query({", createSessionStart);
  assert.ok(queryCallIndex > createSessionStart, "query({ call site inside createSession");
  const optionsSlice = agentSource.slice(createSessionStart, queryCallIndex);

  const userProvidedOptionsIndex = optionsSlice.indexOf("...userProvidedOptions,");
  assert.ok(userProvidedOptionsIndex >= 0);
  const settingSourcesGateIndex = optionsSlice.indexOf(
    'PAPERCLIP_ACPX_ISOLATED_CONTEXT_SNAPSHOT === "1" && { settingSources: ["user"] }',
  );
  assert.ok(
    settingSourcesGateIndex > userProvidedOptionsIndex,
    "settingSources isolation gate comes after ...userProvidedOptions,",
  );

  const mcpServersBlockIndex = optionsSlice.indexOf("mcpServers: {");
  const mcpServersGateIndex = optionsSlice.indexOf(
    "PAPERCLIP_ACPX_ISOLATED_CONTEXT_SNAPSHOT === \"1\"\n                    ? {}\n                    : (userProvidedOptions?.mcpServers || {})",
  );
  assert.ok(mcpServersBlockIndex >= 0);
  assert.ok(
    mcpServersGateIndex > mcpServersBlockIndex,
    "mcpServers isolation strip is inside the mcpServers: { block",
  );

  const canUseToolIndex = optionsSlice.indexOf("canUseTool: this.canUseTool(sessionId)");
  const allowedToolsGateIndex = optionsSlice.indexOf(
    'PAPERCLIP_ACPX_ISOLATED_CONTEXT_SNAPSHOT === "1" && {\n                allowedTools:',
  );
  assert.ok(canUseToolIndex >= 0);
  assert.ok(
    allowedToolsGateIndex > canUseToolIndex,
    "allowedTools isolation gate comes after canUseTool",
  );

  // The managed-policy env-snapshot hardening: the two isolation env vars
  // must be captured into module-level consts before any function body
  // reads them, so a host-managed policy tier applied later (index.js
  // awaits applyManagedPolicyEnv() after this module's static import already
  // evaluated) cannot silently flip the isolation boundary after load.
  const moduleLevelSnapshotIndex = agentSource.indexOf(
    "const PAPERCLIP_ACPX_ISOLATED_CONTEXT_SNAPSHOT = process.env.PAPERCLIP_ACPX_ISOLATED_CONTEXT;",
  );
  assert.ok(moduleLevelSnapshotIndex >= 0, "module-level isolation env snapshot");
  assert.ok(
    moduleLevelSnapshotIndex < createSessionStart,
    "the env snapshot is captured before createSession ever runs",
  );
  assert.doesNotMatch(
    optionsSlice.slice(userProvidedOptionsIndex),
    /process\.env\.PAPERCLIP_ACPX_ISOLATED_CONTEXT\b/,
    "the isolation gates read the module-level snapshot, not process.env directly",
  );
});
