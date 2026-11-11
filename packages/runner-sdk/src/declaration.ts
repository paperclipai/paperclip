import {
  HARNESS_PROTOCOL_VERSION, RUNNER_HARNESS_PLATFORMS, HarnessProtocolError,
  type RunnerHarnessCapabilities, type RunnerHarnessCredentialDeclaration,
  type RunnerHarnessDeclaration, type RunnerHarnessPlatform, type RunnerHarnessReleaseIdentity, type RunnerHarnessCheckpoint,
  type RunnerHarnessLaunchProfile, type RunnerHarnessLaunchArtifact,
} from "./types.js";
import { exactKeys, jsonObject, record, text } from "./validation.js";
import type { JsonObject } from "./types.js";

const sha256 = /^sha256:[a-f0-9]{64}$/u;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function parseHarnessCapabilities(value: unknown): RunnerHarnessCapabilities {
  const fields = record(value, "capabilities");
  if (Object.keys(fields).length > 64) throw new HarnessProtocolError("too many harness capabilities");
  const result: RunnerHarnessCapabilities = Object.create(null);
  for (const [key, claim] of Object.entries(fields)) {
    if (!/^[a-z][a-zA-Z0-9]{0,95}$/u.test(key) || typeof claim !== "boolean") {
      throw new HarnessProtocolError("harness capabilities must be named boolean claims");
    }
    result[key] = claim;
  }
  return result;
}

export function isHarnessCredentialEnvironmentKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,127}$/u.test(key)
    && !/^(?:PAPERCLIP_|NODE_|NPM_|LD_|DYLD_|GIT_CONFIG)/u.test(key)
    && !["PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "IFS", "NODEPATH", "PYTHONPATH", "PYTHONHOME", "RUBYOPT", "PERL5OPT",
      "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_AUTH_SOCK", "PROMPT_COMMAND", "PS4",
      "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE", "OPENSSL_CONF", "OPENSSL_MODULES", "GIT_EXEC_PATH", "GIT_PROXY_COMMAND",
      "BASH_LOADABLES_PATH", "ZDOTDIR", "COMSPEC", "PATHEXT", "GCONV_PATH", "GLIBC_TUNABLES", "OPENSSL_ENGINES"].includes(key);
}

export function parseRunnerHarnessDeclaration(value: unknown): RunnerHarnessDeclaration {
  const fields = record(value, "harness");
  exactKeys(fields, ["harnessKey", "displayName", "configSchema", "platforms", "capabilities", "runtime", "credentials"], "harness");
  const harnessKey = text(fields.harnessKey, "harness.harnessKey", 96);
  if (!/^[a-z][a-z0-9_-]{0,95}$/u.test(harnessKey)) throw new HarnessProtocolError("invalid harnessKey");
  if (!Array.isArray(fields.platforms) || fields.platforms.length === 0
    || fields.platforms.length > RUNNER_HARNESS_PLATFORMS.length
    || fields.platforms.some(value => !(RUNNER_HARNESS_PLATFORMS as readonly unknown[]).includes(value))
    || new Set(fields.platforms).size !== fields.platforms.length) {
    throw new HarnessProtocolError("harness.platforms must name unique supported platform targets");
  }
  const runtime = record(fields.runtime, "harness.runtime");
  exactKeys(runtime, ["entrypoint", "sha256"], "harness.runtime");
  const entrypoint = text(runtime.entrypoint, "harness.runtime.entrypoint", 1024);
  if (entrypoint.startsWith("/") || entrypoint.includes("\\") || entrypoint.includes(":")
    || entrypoint.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new HarnessProtocolError("harness.runtime.entrypoint must stay inside its package");
  }
  const digest = text(runtime.sha256, "harness.runtime.sha256", 71);
  if (!sha256.test(digest)) throw new HarnessProtocolError("harness.runtime.sha256 must be a sha256 digest");
  let credentials: RunnerHarnessCredentialDeclaration[] | undefined;
  if (fields.credentials !== undefined) {
    if (!Array.isArray(fields.credentials) || fields.credentials.length > 32) throw new HarnessProtocolError("invalid harness credentials");
    const seen = new Set<string>();
    credentials = fields.credentials.map(value => {
      const credential = record(value, "harness credential");
      exactKeys(credential, ["key", "displayName", "required"], "harness credential");
      const key = text(credential.key, "credential.key", 128);
      if (!isHarnessCredentialEnvironmentKey(key) || seen.has(key)) throw new HarnessProtocolError("invalid or duplicate credential environment key");
      if (typeof credential.required !== "boolean") throw new HarnessProtocolError("credential.required must be a boolean");
      seen.add(key);
      return { key, displayName: text(credential.displayName, "credential.displayName", 100), required: credential.required };
    });
  }
  return {
    harnessKey, displayName: text(fields.displayName, "harness.displayName", 100),
    configSchema: jsonObject(fields.configSchema, "harness.configSchema"),
    platforms: [...fields.platforms] as RunnerHarnessPlatform[],
    capabilities: parseHarnessCapabilities(fields.capabilities),
    runtime: { entrypoint, sha256: digest },
    ...(credentials === undefined ? {} : { credentials }),
  };
}

export function parseRunnerHarnessReleaseIdentity(value: unknown): RunnerHarnessReleaseIdentity {
  const fields = record(value, "release identity");
  exactKeys(fields, ["harnessId", "packageName", "version", "integrity", "protocolVersion", "runtimeDigest"], "release identity");
  const harnessId = text(fields.harnessId, "identity.harnessId", 240);
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z][a-z0-9_-]{0,95}$/u.test(harnessId)) throw new HarnessProtocolError("invalid namespaced harness identity");
  const name = text(fields.packageName, "identity.packageName", 214);
  if (!packageName.test(name)) throw new HarnessProtocolError("invalid harness package name");
  const version = text(fields.version, "identity.version", 100);
  if (!semver.test(version)) throw new HarnessProtocolError("invalid harness package version");
  const integrity = text(fields.integrity, "identity.integrity", 128);
  if (!/^(?:sha256-[A-Za-z0-9+/]{43}=|sha512-[A-Za-z0-9+/]{86}==)$/u.test(integrity)) throw new HarnessProtocolError("harness integrity must be a sha256 or sha512 npm SRI value");
  const runtimeDigest = text(fields.runtimeDigest, "identity.runtimeDigest", 71);
  if (!sha256.test(runtimeDigest) || fields.protocolVersion !== HARNESS_PROTOCOL_VERSION) throw new HarnessProtocolError("unsupported harness runtime identity");
  return { harnessId, packageName: name, version, integrity, protocolVersion: HARNESS_PROTOCOL_VERSION, runtimeDigest };
}

export function sameRunnerHarnessRelease(left: RunnerHarnessReleaseIdentity, right: RunnerHarnessReleaseIdentity): boolean {
  return left.harnessId === right.harnessId && left.packageName === right.packageName
    && left.version === right.version && left.integrity === right.integrity
    && left.protocolVersion === right.protocolVersion && left.runtimeDigest === right.runtimeDigest;
}

export const parseHarnessReleaseIdentity = parseRunnerHarnessReleaseIdentity;

/** Syntax and resource bounds only; the registered harness owns its config schema. */
export function parseRunnerHarnessConfig(value: unknown): JsonObject {
  return jsonObject(value, "harness configuration");
}

function isAbsoluteHarnessResourcePath(resource: string): boolean {
  const drive = /^[a-zA-Z]:[\\/]/u.test(resource);
  const unc = resource.startsWith("\\\\") || resource.startsWith("//");
  const windows = drive || unc;
  const parts = windows ? resource.slice(drive ? 3 : 2).split(/[\\/]/u) : resource.split("/");
  return (windows || (resource.startsWith("/") && resource !== "/" && !resource.includes("\\")))
    && (!unc || parts.length >= 2)
    && !parts.some((part, index) => part === "." || part === ".."
      || (windows && (!part || /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part)
        || ((!unc || index >= 2) && /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(part.split(".", 1)[0]!.replace(/ +$/u, ""))))));
}

export function parseRunnerHarnessCheckpoint(value: unknown): RunnerHarnessCheckpoint {
  const fields = record(value, "harness checkpoint");
  exactKeys(fields, ["schema", "identity", "normalizedSessionId", "model", "config", "cwd", "runtimeDirectory", "accountIdentity", "credentialIdentity", "providerSessionIdentity", "providerState", "processGroup"], "harness checkpoint");
  if (fields.schema !== "paperclip.harness-checkpoint.v1" || (fields.processGroup !== null
    && (!Number.isSafeInteger(fields.processGroup) || Number(fields.processGroup) < 1 || Number(fields.processGroup) > 0xffff_ffff))) {
    throw new HarnessProtocolError("invalid harness checkpoint schema or process group");
  }
  const directories: { cwd?: string; runtimeDirectory?: string } = {};
  for (const key of ["cwd", "runtimeDirectory"] as const) {
    if (fields[key] === undefined) continue;
    const directory = text(fields[key], `checkpoint.${key}`, 4096);
    if (!isAbsoluteHarnessResourcePath(directory)) {
      throw new HarnessProtocolError(`checkpoint.${key} must be an absolute contained resource path`);
    }
    directories[key] = directory;
  }
  const result: RunnerHarnessCheckpoint = {
    schema: "paperclip.harness-checkpoint.v1", identity: parseRunnerHarnessReleaseIdentity(fields.identity),
    normalizedSessionId: text(fields.normalizedSessionId, "checkpoint.normalizedSessionId", 160),
    model: text(fields.model, "checkpoint.model", 512), config: parseRunnerHarnessConfig(fields.config),
    ...directories, providerState: jsonObject(fields.providerState, "checkpoint.providerState"),
    ...(fields.accountIdentity === undefined ? {} : { accountIdentity: text(fields.accountIdentity, "checkpoint.accountIdentity", 1024) }),
    ...(fields.credentialIdentity === undefined ? {} : { credentialIdentity: text(fields.credentialIdentity, "checkpoint.credentialIdentity", 1024) }),
    processGroup: fields.processGroup as number | null,
  };
  if (fields.providerSessionIdentity !== undefined) {
    const ids = record(fields.providerSessionIdentity, "checkpoint.providerSessionIdentity");
    exactKeys(ids, ["providerSessionId", "backendSessionId"], "checkpoint.providerSessionIdentity");
    result.providerSessionIdentity = {
      providerSessionId: text(ids.providerSessionId, "checkpoint.providerSessionIdentity.providerSessionId", 160),
      backendSessionId: text(ids.backendSessionId, "checkpoint.providerSessionIdentity.backendSessionId", 160),
    };
  }
  jsonObject(result, "harness checkpoint");
  return result;
}

export function parseRunnerHarnessLaunchProfile(value: unknown): RunnerHarnessLaunchProfile {
  const fields = record(value, "harness launch profile");
  exactKeys(fields, ["schema", "identity", "command", "entrypoint", "args", "environmentKeys"], "harness launch profile");
  if (fields.schema !== "paperclip.harness-launch.v1") throw new HarnessProtocolError("unsupported harness launch profile schema");
  const artifact = (value: unknown, path: string): RunnerHarnessLaunchArtifact => {
    const fields = record(value, path);
    exactKeys(fields, ["path", "sha256"], path);
    const resource = text(fields.path, `${path}.path`, 4096);
    if (!isAbsoluteHarnessResourcePath(resource)) {
      throw new HarnessProtocolError(`${path}.path must be an absolute resource path`);
    }
    const hash = text(fields.sha256, `${path}.sha256`, 71);
    if (!sha256.test(hash)) throw new HarnessProtocolError(`${path}.sha256 must be a sha256 digest`);
    return { path: resource, sha256: hash };
  };
  if (!Array.isArray(fields.args) || fields.args.length > 64
    || fields.args.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")
      || arg.startsWith("/") || arg.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/u.test(arg))) {
    throw new HarnessProtocolError("harness launch arguments must be bounded literals without absolute resource paths");
  }
  if (!Array.isArray(fields.environmentKeys) || fields.environmentKeys.length > 128
    || fields.environmentKeys.some(key => typeof key !== "string" || !isHarnessCredentialEnvironmentKey(key))
    || new Set(fields.environmentKeys).size !== fields.environmentKeys.length) {
    throw new HarnessProtocolError("harness launch environment keys must be unique declared credential keys");
  }
  return { schema: "paperclip.harness-launch.v1", identity: parseRunnerHarnessReleaseIdentity(fields.identity),
    command: artifact(fields.command, "launch.command"),
    ...(fields.entrypoint === undefined ? {} : { entrypoint: artifact(fields.entrypoint, "launch.entrypoint") }),
    args: [...fields.args] as string[], environmentKeys: [...fields.environmentKeys] as string[] };
}
