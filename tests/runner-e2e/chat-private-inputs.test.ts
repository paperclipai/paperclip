import { mkdtempSync, writeFileSync, statSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { stageChatPrivateInputs, readChatPrivateInputs, chatPrivateSetupBlockers, chatLaunchCredentialNames, chatPrivateInputNameIdentity, scrubChatPrivateEnvironment, CHAT_PRIVATE_INPUTS_ENV } from "./chat-private-inputs.js";
import type { MatrixExecution } from "./types.js";
import type { ChatCatalogDescriptor } from "./chat-catalog-registry.js";
import { runtimePrivateRequirements } from "./chat-runtime-private-requirements.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(path.join(tmpdir(), "chat-private-")); roots.push(root); return root; }
const execution = { id: "selected", profile: { credential: "CODEX_AUTH_JSON" }, environment: {} } as MatrixExecution;
it("stages only declared credentials privately and removes them from unrelated process environments", () => {
  const root = fixture(), secrets: string[] = [];
  const descriptor = { requiredCredentials: ["OPENAI_API_KEY"] } satisfies Pick<ChatCatalogDescriptor, "requiredCredentials" | "externalInput">;
  const env = { CODEX_AUTH_JSON: "profile-login", OPENAI_API_KEY: "wizard-value", ANTHROPIC_API_KEY: "other-value", PAPERCLIP_CHAT_EVAL_UNUSED: "unrelated-value" };
  const staged = stageChatPrivateInputs({ execution, descriptor, privateDir: root, env, secrets });
  expect(statSync(staged.filename).mode & 0o077).toBe(0);
  const privateEnv = { [CHAT_PRIVATE_INPUTS_ENV]: staged.filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root };
  const inputs = readChatPrivateInputs("selected", secrets, privateEnv);
  expect(inputs.credentials.OPENAI_API_KEY).toBe("wizard-value"); expect(inputs.read("ANTHROPIC_API_KEY")).toBeUndefined();
  expect(secrets).toContain("wizard-value");
  expect(() => readChatPrivateInputs("other", [], privateEnv)).toThrow("another execution");
  const child = scrubChatPrivateEnvironment({ ...env, ...privateEnv }, [execution]);
  expect(child.CODEX_AUTH_JSON).toBe("profile-login"); expect(child.OPENAI_API_KEY).toBeUndefined(); expect(child.PAPERCLIP_CHAT_EVAL_UNUSED).toBeUndefined();
  expect(scrubChatPrivateEnvironment(child, [], true)[CHAT_PRIVATE_INPUTS_ENV]).toBeUndefined();
  expect(JSON.stringify(chatPrivateInputNameIdentity("selected", privateEnv))).not.toContain("wizard-value");
  chmodSync(staged.filename, 0o644); expect(() => readChatPrivateInputs("selected", [], privateEnv)).toThrow("private0600");
});
it("resolves only the selected provider references and fingerprints names rather than credential values", () => {
  const root = fixture(), configFile = path.join(root, "external.json"), secrets: string[] = [];
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, providers: {
    notion: { disposable: true, resourceIds: ["test-page"], credentialEnv: ["PAPERCLIP_CHAT_EVAL_NOTION_AUTH"], prerequisites: { workspaceId: "test-space", tokenEnv: "PAPERCLIP_CHAT_EVAL_NOTION_AUTH", unrelated: "not-selected" } },
    slack: { disposable: true, resourceIds: ["unrelated"], credentialEnv: ["PAPERCLIP_CHAT_EVAL_SLACK_AUTH"], prerequisites: {} },
  } }), { mode: 0o600 });
  const descriptor = { externalInput: { provider: "notion", fields: ["workspaceId", "tokenEnv"] } } satisfies Pick<ChatCatalogDescriptor, "requiredCredentials" | "externalInput">;
  const staged = stageChatPrivateInputs({ execution, descriptor, privateDir: root, secrets, env: { PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG: configFile, PAPERCLIP_CHAT_EVAL_NOTION_AUTH: "notion-private", PAPERCLIP_CHAT_EVAL_SLACK_AUTH: "slack-private" } });
  const env = { [CHAT_PRIVATE_INPUTS_ENV]: staged.filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root };
  const inputs = readChatPrivateInputs("selected", secrets, env);
  expect(inputs.read("PAPERCLIP_CHAT_EVAL_NOTION_AUTH")).toBe("notion-private"); expect(inputs.read("PAPERCLIP_CHAT_EVAL_SLACK_AUTH")).toBeUndefined();
  expect(JSON.stringify(inputs.configuration("external-provider"))).not.toContain("slack");
  expect(JSON.stringify(inputs.configuration("external-provider"))).not.toContain("not-selected");
  const identity = JSON.stringify(chatPrivateInputNameIdentity("selected", env));
  expect(identity).toContain("PAPERCLIP_CHAT_EVAL_NOTION_AUTH"); expect(identity).not.toContain("notion-private"); expect(identity).not.toContain("test-space");
});
it("stages only an exact declared runtime metadata contract and standard key without dummy provider refs", () => {
  const root = fixture(), configFile = path.join(root, "runtime.json");
  const scenarioId = "execution-environments.prepare-image"; const spec = runtimePrivateRequirements[scenarioId];
  const descriptor = { scenarioId, externalInput: { provider: spec.provider, fields: spec.fields }, requiredCredentials: spec.credentials };
  const runtimeExecution = { ...execution, task: { id: scenarioId } } as MatrixExecution;
  const prerequisites = { imageDigest: "sha256:synthetic-image-pin", imageRef: "owned-image", region: "test-region", disposableNamespace: "owned-test-namespace", toolsManifest: "private-tools-reference", unrelated: "not-selected" };
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, providers: { daytona: { disposable: true, resourceIds: ["owned-test-namespace"], credentialEnv: [], prerequisites } } }), { mode: 0o600 });
  const staged = stageChatPrivateInputs({ execution: runtimeExecution, descriptor, privateDir: root, secrets: [], env: { PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG: configFile, DAYTONA_API_KEY: "selected-daytona-key", ANTHROPIC_API_KEY: "unrelated-key" } });
  const env = { [CHAT_PRIVATE_INPUTS_ENV]: staged.filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root };
  const inputs = readChatPrivateInputs("selected", [], env);
  expect(inputs.credentials.DAYTONA_API_KEY).toBe("selected-daytona-key"); expect(inputs.credentials.ANTHROPIC_API_KEY).toBeUndefined();
  expect(JSON.stringify(inputs.configuration("external-provider"))).not.toContain("not-selected");
  const publicIdentity = JSON.stringify(chatPrivateInputNameIdentity("selected", env));
  expect(publicIdentity).toContain("imageDigest"); expect(publicIdentity).not.toContain("synthetic-image-pin"); expect(publicIdentity).not.toContain("selected-daytona-key");
  expect(() => stageChatPrivateInputs({ execution, descriptor, privateDir: root, secrets: [], env: {} })).toThrow("another scenario");
});
it("rejects undeclared runtime scenarios and fields before resolving or writing private values", () => {
  const root = fixture(); const spec = runtimePrivateRequirements["execution-environments.prepare-image"];
  for (const descriptor of [
    { scenarioId: "tasks.create-backlog", externalInput: { provider: spec.provider, fields: spec.fields }, requiredCredentials: spec.credentials },
    { scenarioId: "execution-environments.prepare-image", externalInput: { provider: spec.provider, fields: [...spec.fields, "arbitraryCommand"] }, requiredCredentials: spec.credentials },
    { scenarioId: "execution-environments.prepare-image", externalInput: { provider: spec.provider, fields: spec.fields }, requiredCredentials: [] },
  ]) expect(() => stageChatPrivateInputs({ execution: { ...execution, task: { id: descriptor.scenarioId } } as MatrixExecution, descriptor, privateDir: root, secrets: [], env: {} })).toThrow("exact selected canonical case");
});
it("resolves only the finite SSH private key reference and refuses an alternate ambient name", () => {
  const root = fixture(), configFile = path.join(root, "ssh.json"); const scenarioId = "execution-environments.test-computer"; const spec = runtimePrivateRequirements[scenarioId];
  const descriptor = { scenarioId, externalInput: { provider: spec.provider, fields: spec.fields }, requiredCredentials: spec.credentials };
  const prerequisites = { hostname: "synthetic.test", port: "22", login: "eval", hostKeySha256: "SHA256:synthetic", knownHosts: "synthetic.test ssh-ed25519 synthetic-private-metadata", allowedRemoteRoot: "/owned/disposable", privateKeyEnv: "PAPERCLIP_CHAT_EVAL_SSH_PRIVATE_KEY", qualifiedHarness: "native-codex" };
  const config = { schemaVersion: 1, providers: { ssh: { disposable: true, resourceIds: ["owned-ssh"], credentialEnv: [], prerequisites } } };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const staged = stageChatPrivateInputs({ execution: { ...execution, task: { id: scenarioId } } as MatrixExecution, descriptor, privateDir: root, secrets: [], env: { PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG: configFile, PAPERCLIP_CHAT_EVAL_SSH_PRIVATE_KEY: "selected-ssh-key" } });
  const inputs = readChatPrivateInputs("selected", [], { [CHAT_PRIVATE_INPUTS_ENV]: staged.filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root });
  expect(inputs.read("PAPERCLIP_CHAT_EVAL_SSH_PRIVATE_KEY")).toBe("selected-ssh-key"); expect(inputs.read("PAPERCLIP_CHAT_EVAL_OTHER_KEY")).toBeUndefined();
  prerequisites.privateKeyEnv = "PAPERCLIP_CHAT_EVAL_OTHER_KEY"; writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  rmSync(staged.filename);
  const blocked = stageChatPrivateInputs({ execution: { ...execution, task: { id: scenarioId } } as MatrixExecution, descriptor, privateDir: root, secrets: [], env: { PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG: configFile, PAPERCLIP_CHAT_EVAL_OTHER_KEY: "wrong-key" } });
  const blockedInputs = readChatPrivateInputs("selected", [], { [CHAT_PRIVATE_INPUTS_ENV]: blocked.filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root });
  expect(chatPrivateSetupBlockers(blockedInputs, descriptor)).toContain("unavailable-external-configuration:ssh"); expect(blockedInputs.read("PAPERCLIP_CHAT_EVAL_OTHER_KEY")).toBeUndefined();
});

it("retains missing selected credentials inside a reserved setup receipt while profile credentials stay launch prerequisites", () => {
  const root = fixture(); const descriptor = { requiredCredentials: ["OPENAI_API_KEY" as const] };
  const selected = { ...execution, requiredCredentials: ["CODEX_AUTH_JSON", "OPENAI_API_KEY"] } as MatrixExecution;
  const staged = stageChatPrivateInputs({ execution: selected, descriptor, privateDir: root, secrets: [], env: {} });
  const env = { [CHAT_PRIVATE_INPUTS_ENV]: staged.filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root };
  const inputs = readChatPrivateInputs("selected", [], env);
  expect(chatPrivateSetupBlockers(inputs, descriptor)).toEqual(["missing-credential:OPENAI_API_KEY"]);
  expect(chatPrivateInputNameIdentity("selected", env)?.credentialNames).toEqual(["OPENAI_API_KEY"]);
  expect(chatLaunchCredentialNames(selected, descriptor)).toEqual(["CODEX_AUTH_JSON"]);
  expect(chatLaunchCredentialNames({ ...selected, profile: { ...selected.profile, credential: "OPENAI_API_KEY" } }, descriptor)).toContain("OPENAI_API_KEY");
});
it("stages missing provider fields/configuration as sanitized setup blockers without leaking private filenames", () => {
  const root = fixture(); const descriptor = { externalInput: { provider: "notion" as const, fields: ["recentFactJson"] } };
  const staged = stageChatPrivateInputs({ execution, descriptor, privateDir: root, secrets: [], env: { PAPERCLIP_CHAT_CATALOG_EXTERNAL_CONFIG: "/private/not-an-existing-fixture" } });
  const inputs = readChatPrivateInputs("selected", [], { [CHAT_PRIVATE_INPUTS_ENV]: staged.filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root });
  expect(chatPrivateSetupBlockers(inputs, descriptor)).toEqual(["unavailable-external-configuration:notion"]);
  expect(JSON.stringify(inputs.setupBlockers)).not.toContain("not-an-existing-fixture");
});
