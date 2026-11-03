import assert from "node:assert/strict";
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
