import { StringDecoder } from "node:string_decoder";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { verifyCopilotInstallation } from "./acpx/copilot-installation.js";
import { QUALIFIED_ACPX_PROFILES, resolveQualifiedAcpxProfile } from "./acpx/qualified-profiles.js";
import { classifyCopilotFailure, copilotConfiguration, copilotSandboxEnvironment } from "./acpx/copilot-profile.js";
import { COPILOT_ACP_CLIENT_CAPABILITIES } from "./acpx/copilot-events.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const METHODS = new Set(["initialize", "session/new", "session/set_model", "session/set_config_option", "session/close"]);
export type CopilotMetadataResult =
  | { status: "verified"; version: "1.0.88"; profileDigest: string; models: Array<{ id: string; label: string }>; promptSent: false }
  | { status: "failed"; code: string; message: string; promptSent: false };

/** A metadata-only client: no prompt, tool server, workspace, or ambient login. */
export async function probeCopilotMetadata(token: string, model?: string): Promise<CopilotMetadataResult> {
  if (model && ["auto", "default"].includes(model.trim().toLowerCase())) return { status: "failed", code: "COPILOT_MODEL_UNAVAILABLE", message: "Select an explicit Copilot model.", promptSent: false };
  if (!token.trim() || token.includes("\0")) return { status: "failed", code: "COPILOT_AUTH_REQUIRED", message: "Enter a valid Copilot personal access token.", promptSent: false };
  let installation;
  try { installation = await verifyCopilotInstallation(resolveQualifiedAcpxProfile("copilot", model ?? "metadata-discovery")); }
  catch { return { status: "failed", code: "COPILOT_INSTALLATION_INVALID", message: "The selected environment does not have the verified Copilot runtime installed.", promptSent: false }; }
  let root: string | undefined;
  let lease: Awaited<ReturnType<typeof installation.openCommand>> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let phase = "installation";
  try {
    lease = await installation.openCommand();
    root = await mkdtemp(join(tmpdir(), "paperclip-copilot-metadata-"));
    const directories = { homeDirectory: join(root, "home"), configDirectory: join(root, "config"), dataDirectory: join(root, "data"), cacheDirectory: join(root, "cache"), agentHomeDirectory: join(root, "copilot") };
    for (const directory of Object.values(directories)) await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directories.agentHomeDirectory, "config.json"), JSON.stringify(copilotConfiguration()), { mode: 0o600 });
    child = lease.spawn([], { cwd: root, env: { PATH: "/usr/bin:/bin", ...copilotSandboxEnvironment(directories), COPILOT_GITHUB_TOKEN: token }, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
    closed = new Promise(resolve => child!.once("close", () => resolve()));
    const rpc = createMetadataRpc(child);
    const work = async (): Promise<CopilotMetadataResult> => {
      phase = "initialize";
      const initialized = record(await rpc.request("initialize", { protocolVersion: 1, clientInfo: { name: "paperclip-copilot-metadata", version: "1" }, clientCapabilities: COPILOT_ACP_CLIENT_CAPABILITIES }));
      if (record(initialized.agentInfo).version !== "1.0.88") throw Object.assign(new Error("Verified Copilot installation changed"), { code: "COPILOT_INSTALLATION_INVALID" });
      phase = "session-new";
      const opened = record(await rpc.request("session/new", { cwd: root, mcpServers: [] }));
      const advertised = record(opened.models).availableModels;
      const models = (Array.isArray(advertised) ? advertised : []).slice(0, 200).flatMap(value => {
        const entry = record(value), id = entry.modelId;
        return typeof id === "string" && !["auto", "default"].includes(id.toLowerCase()) && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(id)
          ? [{ id, label: typeof entry.name === "string" && !/[\x00-\x1f\x7f]|github_pat_|gh[pousr]_/.test(entry.name) ? entry.name.slice(0, 200) : id }] : [];
      });
      if (!models.length) throw new Error("Copilot model discovery unavailable");
      if (model) {
        if (!models.some(value => value.id === model)) throw Object.assign(new Error("Selected Copilot model unavailable"), { code: "COPILOT_MODEL_UNAVAILABLE" });
        phase = "model-selection";
        await rpc.request("session/set_model", { sessionId: opened.sessionId, modelId: model });
        phase = "model-confirmation";
        const configured = record(await rpc.request("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: model }));
        if (!Array.isArray(configured.configOptions) || !configured.configOptions.some(option => record(option).id === "model" && record(option).currentValue === model)) {
          throw Object.assign(new Error("Selected Copilot model unavailable"), { code: "COPILOT_MODEL_UNAVAILABLE" });
        }
      }
      // EOF is the authoritative stdio shutdown; session/close is optional.
      return { status: "verified", version: "1.0.88", profileDigest: installation.commandDigest, models, promptSent: false };
    };
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("Copilot metadata probe timed out")), 25_000);
    })]);
  } catch (error) {
    const code = record(error).code;
    if (code === "COPILOT_INSTALLATION_INVALID") return { status: "failed", code, message: "The selected environment has an incompatible Copilot installation.", promptSent: false };
    if (code === "COPILOT_MODEL_UNAVAILABLE") return { status: "failed", code, message: "The selected Copilot model is unavailable for this account.", promptSent: false };
    const failure = classifyCopilotFailure(error);
    const cause = error instanceof Error && error.message === "Copilot metadata probe timed out" ? "deadline"
      : error instanceof Error && error.message === "Copilot provider exited during metadata discovery" ? "provider-exit" : "request-rejected";
    // Only closed diagnostic categories; never log provider errors, wire data,
    // credentials, model catalogs, session IDs or private workspace paths.
    console.warn("Copilot metadata verification failed", JSON.stringify({ phase, code: failure.code, cause }));
    return { status: "failed", ...failure, promptSent: false };
  } finally {
    if (deadline) clearTimeout(deadline);
    if (child && closed) {
      child.stdin.end();
      const term = setTimeout(() => child?.kill("SIGTERM"), 500);
      const kill = setTimeout(() => child?.kill("SIGKILL"), 2_000);
      await closed;
      clearTimeout(term); clearTimeout(kill);
    }
    try { await lease?.close(); } finally { if (root) await rm(root, { recursive: true, force: true }); }
  }
}

export function createMetadataRpc(child: ChildProcessWithoutNullStreams) {
  const decoder = new StringDecoder("utf8");
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0, bytes = 0, buffer = "", failure: Error | undefined;
  const fail = (error: Error) => { failure ??= error; for (const call of pending.values()) call.reject(failure); pending.clear(); };
  child.once("close", () => fail(new Error("Copilot provider exited during metadata discovery")));
  child.once("error", () => fail(new Error("Copilot installation could not start")));
  child.stdin.on("error", () => fail(new Error("Copilot metadata transport unavailable")));
  child.stderr.on("data", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) { fail(new Error("Copilot metadata exceeded its bound")); child.kill("SIGTERM"); return; }
    buffer += decoder.write(chunk);
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: RecordValue;
      try { message = record(JSON.parse(line)); } catch { fail(new Error("Invalid Copilot metadata response")); return; }
      if (message.method) {
        if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Metadata discovery does not support inbound methods" } })}\n`);
        continue;
      }
      const call = pending.get(message.id as number);
      if (!call) continue;
      pending.delete(message.id as number);
      if (message.error) {
        const details = record(message.error);
        call.reject(new Error(typeof details.message === "string" ? details.message.slice(0, 8192) : "Copilot metadata request failed"));
      } else call.resolve(message.result);
    }
  });
  return { request(method: string, params: RecordValue): Promise<unknown> {
    if (!METHODS.has(method)) throw new Error("Metadata discovery cannot send this method");
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  } };
}

const FAILURE_MESSAGES = {
  COPILOT_AUTH_REQUIRED: "Enter a valid Copilot personal access token.",
  COPILOT_ENTITLEMENT_DENIED: "Copilot access is denied by the account entitlement or organization policy.",
  COPILOT_MODEL_UNAVAILABLE: "The selected Copilot model is unavailable for this account.",
  COPILOT_INSTALLATION_INVALID: "Install the verified Copilot runtime in this environment.",
  COPILOT_REQUEST_FAILED: "Copilot metadata verification failed.",
} as const;
/** Validate remote metadata and discard all provider-authored error text. */
export function validateCopilotMetadata(value: unknown): CopilotMetadataResult {
  const result = record(value);
  const invalid = (): CopilotMetadataResult => ({ status: "failed", code: "COPILOT_REQUEST_FAILED", message: FAILURE_MESSAGES.COPILOT_REQUEST_FAILED, promptSent: false });
  if (result.promptSent !== false) return invalid();
  if (result.status === "failed") {
    const code = typeof result.code === "string" && Object.hasOwn(FAILURE_MESSAGES, result.code) ? result.code as keyof typeof FAILURE_MESSAGES : "COPILOT_REQUEST_FAILED";
    return { status: "failed", code, message: FAILURE_MESSAGES[code], promptSent: false };
  }
  if (result.status !== "verified" || result.version !== "1.0.88" || result.profileDigest !== QUALIFIED_ACPX_PROFILES.copilot.commandDigest
    || !Array.isArray(result.models) || result.models.length === 0 || result.models.length > 200) return invalid();
  const models: Array<{ id: string; label: string }> = [];
  const ids = new Set<string>();
  for (const value of result.models) {
    const entry = record(value);
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.label !== "string" || entry.label.length > 200 || /[\x00-\x1f\x7f]|github_pat_|gh[pousr]_/.test(entry.label)) return invalid();
    ids.add(entry.id); models.push({ id: entry.id, label: entry.label });
  }
  return { status: "verified", version: "1.0.88", profileDigest: result.profileDigest, models, promptSent: false };
}
