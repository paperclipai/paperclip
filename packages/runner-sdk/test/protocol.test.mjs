import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HARNESS_MAX_FRAME_BYTES, HARNESS_PROTOCOL_SCHEMA,
  parseHarnessCommand, parseHarnessEvent, parseHarnessFrameText,
  parseHarnessRequest, parseHarnessResponse, serializeHarnessFrame,
  parseRunnerHarnessDeclaration, parseRunnerHarnessReleaseIdentity,
  parseRunnerHarnessCheckpoint, parseRunnerHarnessLaunchProfile,
} from "../dist/index.js";

const identity = { harnessId: "example.fixture/native", packageName: "@example/plugin-native", version: "1.0.0",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, protocolVersion: 1, runtimeDigest: `sha256:${"a".repeat(64)}` };
const command = { schema: "paperclip.prp.command.v1", commandId: "command_1", controllerSeq: 1,
  type: "turn.start", issuedAt: "2026-11-03T00:00:00Z", payload: { message: "work" } };
const declaration = { harnessKey: "native", displayName: "Example Native", configSchema: { type: "object" },
  platforms: ["linux-x64"], capabilities: { resume: true, interruption: true },
  runtime: { entrypoint: "dist/native.mjs", sha256: `sha256:${"b".repeat(64)}` },
  credentials: [{ key: "EXAMPLE_API_KEY", displayName: "API key", required: true }] };

test("strict frames round trip all three directions without provider dependencies", () => {
  const request = parseHarnessRequest({ schema: HARNESS_PROTOCOL_SCHEMA, id: 1, method: "execute", params: { command } });
  const response = parseHarnessResponse({ schema: HARNESS_PROTOCOL_SCHEMA, id: 1, ok: true, result: { admitted: true } });
  const event = parseHarnessEvent({ schema: HARNESS_PROTOCOL_SCHEMA, sequence: 1, eventType: "turn.started", priority: "p0", turnId: "turn_1", payload: {} });
  for (const frame of [request, response, event]) assert.deepEqual(parseHarnessFrameText(serializeHarnessFrame(frame)), frame);
  request.params.command.payload.message = "changed";
  assert.equal(command.payload.message, "work", "validation must detach caller-owned data");
});

test("frame boundary rejects unsupported versions, extra fields, malformed results and unsafe JSON", () => {
  assert.throws(() => parseHarnessRequest({ schema: "future", id: 1, method: "snapshot", params: {} }));
  assert.throws(() => parseHarnessRequest({ schema: HARNESS_PROTOCOL_SCHEMA, id: 1, method: "snapshot", params: {}, extra: true }));
  assert.throws(() => parseHarnessRequest({ schema: HARNESS_PROTOCOL_SCHEMA, id: 1, method: "execute", params: { command, authority: "extra" } }));
  assert.throws(() => parseHarnessResponse({ schema: HARNESS_PROTOCOL_SCHEMA, id: 1, ok: true, result: {}, error: {} }));
  assert.throws(() => parseHarnessCommand({ ...command, controllerSeq: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => parseHarnessCommand({ ...command, payload: { dropped: undefined } }));
  assert.throws(() => parseHarnessCommand({ ...command, payload: { dropped: NaN } }));
  assert.throws(() => parseHarnessCommand({ ...command, payload: { invalid: "\ud800" } }));
  assert.throws(() => parseHarnessCommand({ ...command, payload: { invalid: () => {} } }));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => parseHarnessCommand({ ...command, payload: cyclic }));
  assert.throws(() => parseHarnessFrameText(" ".repeat(HARNESS_MAX_FRAME_BYTES + 1)));
  assert.throws(() => parseHarnessFrameText("{} garbage"));
});

test("error message schema and parser agree on bounded single-line text", () => {
  const schema = JSON.parse(readFileSync(new URL("../protocol/harness.schema.json", import.meta.url), "utf8"));
  const messageSchema = schema.$defs.response.properties.error.properties.message;
  const pattern = new RegExp(messageSchema.pattern, "u");
  for (const [message, accepted] of [
    ["Native session failed", true], ["x".repeat(161), true], ["x".repeat(8192), true],
    ["Native session failed\nRetry later", false], ["Native session failed\n", false],
    ["Native session failed\r", false], ["Native\tsession failed", false],
    ["Native session\u0000 failed", false], ["Native session\u007f failed", false],
    ["", false], ["   ", false], ["x".repeat(8193), false],
  ]) {
    const schemaAccepted = typeof message === messageSchema.type && message.length >= messageSchema.minLength
      && message.length <= messageSchema.maxLength && pattern.test(message);
    assert.equal(schemaAccepted, accepted, JSON.stringify(message));
    const response = { schema: HARNESS_PROTOCOL_SCHEMA, id: 1, ok: false,
      error: { code: "session_failed", message, retryable: false } };
    if (accepted) assert.equal(parseHarnessResponse(response).error.message, message);
    else assert.throws(() => parseHarnessResponse(response), undefined, JSON.stringify(message));
  }
});

test("declarations confine runtime entrypoints and credential environment", () => {
  assert.equal(parseRunnerHarnessDeclaration(declaration).runtime.entrypoint, "dist/native.mjs");
  for (const entrypoint of ["/bin/sh", "../run.mjs", "dist/../run.mjs", "C:\\run.mjs", "./run.mjs", "dist//run.mjs"]) {
    assert.throws(() => parseRunnerHarnessDeclaration({ ...declaration, runtime: { ...declaration.runtime, entrypoint } }));
  }
  for (const key of ["PATH", "HOME", "LD_PRELOAD", "NODE_OPTIONS", "PAPERCLIP_RUNNER_EXTENSION_PROFILE"]) {
    assert.throws(() => parseRunnerHarnessDeclaration({ ...declaration, credentials: [{ key, displayName: key, required: true }] }));
  }
  assert.throws(() => parseRunnerHarnessDeclaration({ ...declaration, credentials: [...declaration.credentials, ...declaration.credentials] }));
  assert.throws(() => parseRunnerHarnessDeclaration({ ...declaration, platforms: ["linux-x64", "linux-x64"] }));
  assert.throws(() => parseRunnerHarnessDeclaration({ ...declaration, capabilities: { resume: "yes" } }));
});

test("release identity binds namespace, exact npm version, package integrity and runtime digest", () => {
  assert.deepEqual(parseRunnerHarnessReleaseIdentity(identity), identity);
  for (const value of [
    { ...identity, harnessId: "builtin" }, { ...identity, version: "latest" },
    { ...identity, integrity: "sha512-short" }, { ...identity, protocolVersion: 2 },
    { ...identity, runtimeDigest: "unverified" }, { ...identity, command: "/bin/sh" },
  ]) assert.throws(() => parseRunnerHarnessReleaseIdentity(value));
});

test("private launch profiles pin every executable artifact and reject environment control", () => {
  const launch = { schema: "paperclip.harness-launch.v1", identity,
    command: { path: "/private/runtime/node", sha256: `sha256:${"c".repeat(64)}` },
    entrypoint: { path: "/private/runtime/harness.cjs", sha256: `sha256:${"d".repeat(64)}` },
    args: ["--fixture"], environmentKeys: ["EXAMPLE_API_KEY"] };
  assert.deepEqual(parseRunnerHarnessLaunchProfile(launch), launch);
  for (const value of [
    { ...launch, args: ["/unverified/script.cjs"] }, { ...launch, environmentKeys: ["NODE_OPTIONS"] },
    { ...launch, command: { ...launch.command, path: "relative/node" } },
    { ...launch, command: { ...launch.command, sha256: "unpinned" } },
    { ...launch, entrypoint: { ...launch.entrypoint, path: "/private/../unverified.cjs" } },
    { ...launch, environment: { EXAMPLE_API_KEY: "forbidden inline secret" } },
  ]) assert.throws(() => parseRunnerHarnessLaunchProfile(value));
});

test("checkpoints preserve exact release and bounded native state without accepting executable authority", () => {
  const checkpoint = { schema: "paperclip.harness-checkpoint.v1", identity,
    normalizedSessionId: "session_1", model: "selected-model", config: { effort: "high" },
    cwd: "/workspace/task", runtimeDirectory: "/runtime/harness", providerState: { nativeSessionId: "native_1" }, processGroup: null };
  assert.deepEqual(parseRunnerHarnessCheckpoint(checkpoint), checkpoint);
  const accountBound = { ...checkpoint, accountIdentity: "selected-account", credentialIdentity: "credential-revision" };
  assert.deepEqual(parseRunnerHarnessCheckpoint(accountBound), accountBound);
  const nativeBound = { ...checkpoint, providerSessionIdentity: { providerSessionId: "native-thread", backendSessionId: "native-session" } };
  assert.deepEqual(parseRunnerHarnessCheckpoint(nativeBound), nativeBound);
  for (const value of [
    { ...checkpoint, processGroup: -1 }, { ...checkpoint, processGroup: 0x1_0000_0000 },
    { ...checkpoint, cwd: "/workspace/../other" }, { ...checkpoint, command: "/bin/sh" },
    { ...checkpoint, providerState: { invalid: undefined } },
    { ...checkpoint, accountIdentity: "" }, { ...checkpoint, credentialIdentity: { unexpected: true } },
    { ...checkpoint, providerSessionIdentity: { providerSessionId: "native-thread" } },
    { ...checkpoint, providerSessionIdentity: { providerSessionId: "native-thread", backendSessionId: "" } },
    { ...nativeBound, providerSessionIdentity: { ...nativeBound.providerSessionIdentity, invented: "authority" } },
  ]) assert.throws(() => parseRunnerHarnessCheckpoint(value));
});


test("checkpoint directories accept absolute Windows paths without unsafe path aliases", () => {
  const checkpoint = { schema: "paperclip.harness-checkpoint.v1", identity,
    normalizedSessionId: "session_1", model: "selected-model", config: {}, providerState: {}, processGroup: null };
  for (const directory of [String.raw`C:\workspace\task`, "C:/workspace/task"]) {
    assert.deepEqual(parseRunnerHarnessCheckpoint({ ...checkpoint, cwd: directory, runtimeDirectory: directory }),
      { ...checkpoint, cwd: directory, runtimeDirectory: directory });
  }
  for (const directory of ["C:workspace/task", "C:/", "C:\\", "C:/workspace/../other", "C:/workspace/./task",
    String.raw`C:\workspace\..\other`, "C:/workspace/task:stream", "C:/workspace/task?", "C:/workspace/task.",
    "C:/workspace/task ", "C:/workspace/ta\u0000sk"]) {
    assert.throws(() => parseRunnerHarnessCheckpoint({ ...checkpoint, cwd: directory }), undefined, directory);
  }
});


test("credential declarations and launch profiles reject process-control environment keys", () => {
  const keys = ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_AUTH_SOCK", "PROMPT_COMMAND", "PS4",
    "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE", "OPENSSL_CONF", "OPENSSL_MODULES", "GIT_EXEC_PATH", "GIT_PROXY_COMMAND",
    "BASH_LOADABLES_PATH", "ZDOTDIR", "COMSPEC", "PATHEXT", "GCONV_PATH", "GLIBC_TUNABLES", "OPENSSL_ENGINES"];
  const launch = { schema: "paperclip.harness-launch.v1", identity,
    command: { path: "/runtime/node", sha256: `sha256:${"c".repeat(64)}` }, args: [], environmentKeys: [] };
  for (const key of keys) {
    assert.throws(() => parseRunnerHarnessDeclaration({ ...declaration, credentials: [{ key, displayName: key, required: true }] }), undefined, key);
    assert.throws(() => parseRunnerHarnessLaunchProfile({ ...launch, environmentKeys: [key] }), undefined, key);
  }
  for (const key of ["EXAMPLE_API_KEY", "GIT_TOKEN", "GITHUB_TOKEN"]) {
    assert.equal(parseRunnerHarnessDeclaration({ ...declaration, credentials: [{ key, displayName: key, required: true }] }).credentials[0].key, key);
    assert.deepEqual(parseRunnerHarnessLaunchProfile({ ...launch, environmentKeys: [key] }).environmentKeys, [key]);
  }
});

test("checkpoints and launch profiles accept ordinary UNC paths and reject devices or traversal", () => {
  const checkpoint = { schema: "paperclip.harness-checkpoint.v1", identity, normalizedSessionId: "session_1",
    model: "selected-model", config: {}, providerState: {}, processGroup: null };
  const launch = { schema: "paperclip.harness-launch.v1", identity,
    command: { path: "/runtime/node", sha256: `sha256:${"c".repeat(64)}` }, args: [], environmentKeys: [] };
  for (const directory of [String.raw`\\server\share`, String.raw`\\server\share\task`, "//server/share/task",
    String.raw`\\aux\share\project`, String.raw`\\server\con\project`, String.raw`\\aux\con`, "//con/aux/project"]) {
    assert.equal(parseRunnerHarnessCheckpoint({ ...checkpoint, cwd: directory }).cwd, directory);
    assert.equal(parseRunnerHarnessLaunchProfile({ ...launch, command: { ...launch.command, path: directory } }).command.path, directory);
    assert.throws(() => parseRunnerHarnessLaunchProfile({ ...launch, args: [directory] }));
  }
  for (const directory of [String.raw`\\server`, String.raw`\\server\share\..\other`, String.raw`\\?\C:\task`,
    String.raw`\\.\pipe\native`, "//?/C:/task", "//server/share/task:stream", "//server/./task", "//server/share/task.",
    "//aux/con/../task", "//aux?/con/task", "//aux/con./task", "//../share/project"]) {
    assert.throws(() => parseRunnerHarnessCheckpoint({ ...checkpoint, cwd: directory }), undefined, directory);
    assert.throws(() => parseRunnerHarnessLaunchProfile({ ...launch, command: { ...launch.command, path: directory } }), undefined, directory);
  }
});


test("Windows resource paths reject reserved DOS device names and aliases", () => {
  const checkpoint = { schema: "paperclip.harness-checkpoint.v1", identity, normalizedSessionId: "session_1",
    model: "selected-model", config: {}, providerState: {}, processGroup: null };
  const launch = { schema: "paperclip.harness-launch.v1", identity,
    command: { path: "/runtime/node", sha256: `sha256:${"c".repeat(64)}` }, args: [], environmentKeys: [] };
  const names = ["NUL", "nul", "CON", "con.txt", "CON .txt", "PRN.tar.gz", "AUX", "COM1", "COM9.log", "LPT1",
    "LPT9.backup", "COM¹", "COM².txt", "LPT³", "CONIN$", "CONOUT$.log"];
  const invalid = [String.raw`C:\NUL`, String.raw`C:\foo\CON`, String.raw`C:\COM1\bar`, String.raw`\\server\share\NUL`,
    ...names.flatMap(name => [`C:/workspace/${name}`, `C:/workspace/${name}/child`, `//server/share/${name}`, `//aux/con/${name}`])];
  for (const directory of invalid) {
    assert.throws(() => parseRunnerHarnessCheckpoint({ ...checkpoint, cwd: directory }), undefined, directory);
    assert.throws(() => parseRunnerHarnessLaunchProfile({ ...launch, command: { ...launch.command, path: directory } }), undefined, directory);
  }
  for (const directory of ["C:/workspace/connection.txt", "C:/workspace/NULfile", "C:/workspace/com10", "C:/workspace/lpt11",
    "//server/share/normal.txt", "/workspace/NUL.txt"]) {
    assert.equal(parseRunnerHarnessCheckpoint({ ...checkpoint, cwd: directory }).cwd, directory);
    assert.equal(parseRunnerHarnessLaunchProfile({ ...launch, command: { ...launch.command, path: directory } }).command.path, directory);
  }
});
