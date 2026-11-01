import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { antigravityNativeDistributionSpec } from "./antigravity-installation.js";
import { antigravityPrivateEnvironment, checkAntigravityPrivateHome, retireAntigravityProcess } from "./antigravity-process.js";
import { verifyNativeAcpxInstallation, type VerifiedAcpxCommandLease } from "./installation-integrity.js";

const SCHEMA = "paperclip.antigravity.models.v1";
const ERROR = "Could not load models for this Google account. Retry or sign in again.";
const MAX_WIRE_BYTES = 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export type AntigravityModelCatalog = { models: Array<{ id: string; label: string }>; defaultModelId: string };

/** The caller must keep its credential home until retired resolves. The owned
 * cleanup operation retains the child and command lease throughout uncertainty.
 */
export class AntigravityModelDiscoveryCleanupError extends Error {
  readonly code = "ANTIGRAVITY_MODELS_CLEANUP_PENDING";
  constructor(
    readonly retired: Promise<void>,
    readonly operationError: Error | undefined,
    readonly cleanupError: Error,
  ) {
    super("Antigravity model discovery failed while its process was stopping.");
    this.name = "AntigravityModelDiscoveryCleanupError";
  }
}

function retainCatalogCleanup(child: ChildProcessWithoutNullStreams | undefined, closed: Promise<void> | undefined, lease: VerifiedAcpxCommandLease): Promise<void> {
  let observedClose = child === undefined;
  void closed?.then(() => { observedClose = true; });
  return (async () => {
    // This retry belongs only to an unresolved, active process/lease cleanup.
    // Close wakes it immediately; successful cleanup leaves no timer or work.
    while (true) {
      try {
        if (child && closed) await retireAntigravityProcess(child, closed);
        await lease.close();
        return;
      } catch {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const retry = new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); });
        try { await (observedClose || !closed ? retry : Promise.race([closed, retry])); }
        finally { if (timer) clearTimeout(timer); }
      }
    }
  })();
}

function catalog(value: unknown, nonce: string): AntigravityModelCatalog {
  const response = record(value);
  if (response.schema !== SCHEMA || response.nonce !== nonce || response.authMethod !== "oauth-personal"
    || !Array.isArray(response.models) || response.models.length < 1 || response.models.length > 200) throw new Error(ERROR);
  const ids = new Set<string>(), models: AntigravityModelCatalog["models"] = [];
  for (const value of response.models) {
    const model = record(value);
    if (typeof model.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(model.id)
      || ["auto", "default"].includes(model.id.toLowerCase()) || ids.has(model.id)
      || typeof model.label !== "string" || !model.label.trim() || model.label.length > 200 || /[\x00-\x1f\x7f]/.test(model.label)) throw new Error(ERROR);
    ids.add(model.id); models.push({ id: model.id, label: model.label });
  }
  if (typeof response.defaultModelId !== "string" || !ids.has(response.defaultModelId)) throw new Error(ERROR);
  return { models, defaultModelId: response.defaultModelId };
}

/** Read-only account catalog discovery through the pinned native implementation.
 * The caller owns the private projected credential home and any refreshed-secret
 * writeback. Execution retires before ordinary results/errors. A cleanup error
 * transfers the home-retention obligation through its retired completion.
 */
export async function discoverAntigravityModels(home: string, options: { signal?: AbortSignal } = {}): Promise<AntigravityModelCatalog> {
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let lease: VerifiedAcpxCommandLease | undefined, child: ChildProcessWithoutNullStreams | undefined, closed: Promise<void> | undefined;
  let result: AntigravityModelCatalog | undefined, failure: Error | undefined;
  let cleanupError: AntigravityModelDiscoveryCleanupError | undefined;
  try {
    signal.throwIfAborted();
    await checkAntigravityPrivateHome(home);
    signal.throwIfAborted();
    const installation = await verifyNativeAcpxInstallation(antigravityNativeDistributionSpec());
    signal.throwIfAborted();
    lease = await installation.openCommand({ signal });
    const environment = await antigravityPrivateEnvironment(home);
    signal.throwIfAborted();
    child = lease.spawn([], { cwd: home, stdio: "pipe", detached: process.platform !== "win32", env: environment }) as ChildProcessWithoutNullStreams;
    const peer = child;
    closed = new Promise(resolve => peer.once("close", () => resolve()));
    const nonce = randomUUID();
    result = await new Promise<AntigravityModelCatalog>((resolve, reject) => {
      let phase = 1, stdout = "", outputBytes = 0, errorBytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const fail = () => { failure ??= new Error(ERROR); reject(failure); };
      const abort = () => fail();
      signal.addEventListener("abort", abort, { once: true });
      const send = (id: 1 | 2) => peer.stdin.write(`${JSON.stringify(id === 1
        ? { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "paperclip-runner", version: "1" }, clientCapabilities: {} } }
        : { jsonrpc: "2.0", id, method: "_paperclip/models", params: { schema: SCHEMA, nonce, authMethod: "oauth-personal" } })}\n`);
      peer.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_WIRE_BYTES) { fail(); return; }
        try { stdout += decoder.decode(chunk, { stream: true }); } catch { fail(); return; }
        while (stdout.includes("\n") && !failure) {
          const end = stdout.indexOf("\n"), line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
          if (!line.trim()) continue;
          let message: Record<string, unknown>;
          try { message = record(JSON.parse(line)); } catch { fail(); return; }
          if (phase > 2 || message.jsonrpc !== "2.0" || message.id !== phase || "method" in message || "error" in message || !Object.hasOwn(message, "result")) { fail(); return; }
          if (phase === 1) {
            const initialized = record(message.result), info = record(initialized.agentInfo), capabilities = record(record(record(initialized.agentCapabilities)._meta).antigravity);
            if (initialized.protocolVersion !== 1 || info.name !== "antigravity-acp" || info.version !== "1.4.3"
              || capabilities.paperclipAdmission !== 1 || capabilities.paperclipModels !== 1
              || !Array.isArray(initialized.authMethods) || !initialized.authMethods.some(value => record(value).id === "oauth-personal")) { fail(); return; }
            phase = 2; send(2);
          } else {
            try { const models = catalog(message.result, nonce); phase = 3; resolve(models); } catch { fail(); }
          }
        }
      });
      peer.stdout.once("end", () => {
        try { stdout += decoder.decode(); if (stdout.trim()) fail(); } catch { fail(); }
      });
      // Native error text may contain private account data. Count and discard.
      peer.stderr.on("data", (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > MAX_WIRE_BYTES) fail(); });
      peer.once("error", fail);
      peer.once("close", () => { signal.removeEventListener("abort", abort); if (phase !== 3) fail(); });
      peer.stdin.on("error", () => { if (phase !== 3) fail(); });
      if (signal.aborted) fail(); else send(1);
    });
  } catch { failure ??= new Error(ERROR); }
  finally {
    try {
      if (child && closed) await retireAntigravityProcess(child, closed);
      await lease?.close();
    } catch (error) {
      if (lease) cleanupError = new AntigravityModelDiscoveryCleanupError(
        retainCatalogCleanup(child, closed, lease), failure,
        error instanceof Error ? error : new Error("Antigravity process retirement or command lease release could not be confirmed"),
      );
      else failure ??= new Error(ERROR);
    }
    clearTimeout(timer);
  }
  if (cleanupError) throw cleanupError;
  if (signal.aborted || failure || result === undefined) throw failure ?? new Error(ERROR);
  return result;
}
