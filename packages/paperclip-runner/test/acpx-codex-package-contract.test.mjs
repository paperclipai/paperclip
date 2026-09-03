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

test("the runner pins every qualified ACPX production dependency", () => {
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

test("the package exposes only the reviewed runner CLI binaries", () => {
  assert.deepEqual(runnerPackage.bin, {
    "paperclip-runner-eval-session": "./dist/cli/eval-session.js",
    "paperclip-runner-codex-proxy":
      "./dist/cli/codex-app-server-unix-proxy.js",
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
    /codex-acp@1\.6\.2': patches\/@agentclientprotocol__codex-acp@1\.6\.2\.patch/,
  );
  assert.match(
    workspace,
    /claude-agent-acp@0\.70\.0': patches\/@agentclientprotocol__claude-agent-acp@0\.70\.0\.patch/,
  );
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
