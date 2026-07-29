import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SshRemoteExecutionSpec } from "./ssh.js";
import {
  prepareCommandManagedRuntime,
  type CommandManagedRuntimeAsset,
  type CommandManagedRuntimeRunner,
} from "./command-managed-runtime.js";
import {
  buildRemoteExecutionSessionIdentity,
  prepareRemoteManagedRuntime,
  remoteExecutionSessionMatches,
} from "./remote-managed-runtime.js";
import {
  createCommandManagedSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAsset,
  createSandboxCallbackBridgeToken,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeServer,
  startSandboxCallbackBridgeWorker,
} from "./sandbox-callback-bridge.js";
import {
  createSandboxRunLogTailFactory,
  type SandboxRunLogTailFactory,
} from "./sandbox-run-log-stream.js";
import { createSshCommandManagedRuntimeRunner, parseSshRemoteExecutionSpec, runSshCommand, shellQuote } from "./ssh.js";
import {
  ensureCommandResolvable,
  resolveCommandForLogs,
  runChildProcess,
  type RunProcessResult,
  type TerminalResultCleanupOptions,
} from "./server-utils.js";
import { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";
import { preferredShellForSandbox, shellCommandArgs } from "./sandbox-shell.js";
import type { RuntimeProgressSink, RuntimeStatusSink } from "./runtime-progress.js";
import type { LocalProcessSandboxOptions } from "./local-process-sandbox.js";

export type { RuntimeProgressSink } from "./runtime-progress.js";

export interface AdapterLocalExecutionTarget {
  kind: "local";
  environmentId?: string | null;
  leaseId?: string | null;
}

export interface AdapterSshExecutionTarget {
  kind: "remote";
  transport: "ssh";
  environmentId?: string | null;
  leaseId?: string | null;
  remoteCwd: string;
  spec: SshRemoteExecutionSpec;
}

export interface AdapterSandboxExecutionTarget {
  kind: "remote";
  transport: "sandbox";
  providerKey?: string | null;
  shellCommand?: "bash" | "sh" | null;
  environmentId?: string | null;
  leaseId?: string | null;
  remoteCwd: string;
  timeoutMs?: number | null;
  runner?: CommandManagedRuntimeRunner;
  /**
   * Sandbox-backed adapter runs stream the agent CLI's stdout/stderr
   * incrementally via a log-tail loop beside the callback bridge instead of
   * waiting for the batched provider result. Streaming is ON by default;
   * set to `false` to explicitly opt out back to batch-at-end delivery.
   */
  streamRunLogs?: boolean | null;
}

export type AdapterExecutionTarget =
  | AdapterLocalExecutionTarget
  | AdapterSshExecutionTarget
  | AdapterSandboxExecutionTarget;

export type AdapterRemoteExecutionSpec = SshRemoteExecutionSpec;

// The adapter-facing managed-runtime asset type. Aliased to the sandbox/command
// asset descriptor so the per-asset lifecycle contributions (`provision` /
// `restore`) declared on the sandbox core are load-bearing all the way from the
// adapter call site through to the sandbox runtime. The SSH transport consumes
// the subset of fields it understands and ignores the rest.
export type AdapterManagedRuntimeAsset = CommandManagedRuntimeAsset;

export interface PreparedAdapterExecutionTargetRuntime {
  target: AdapterExecutionTarget;
  workspaceRemoteDir: string | null;
  runtimeRootDir: string | null;
  assetDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

export interface AdapterExecutionTargetProcessOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onRuntimeProgress?: RuntimeStatusSink;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  terminalResultCleanup?: TerminalResultCleanupOptions;
  /**
   * Sandbox-only: factory from the Paperclip bridge handle that streams the
   * CLI's stdout/stderr during the run. When provided, the batched provider
   * onLog is suppressed and incremental chunks flow through `onLog` instead.
   */
  runLogTail?: SandboxRunLogTailFactory | null;
  localProcessSandbox?: LocalProcessSandboxOptions | null;
}

export interface AdapterExecutionTargetShellOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface AdapterExecutionTargetPaperclipBridgeHandle {
  env: Record<string, string>;
  /**
   * Present when the sandbox target opted into run-log streaming
   * (`streamRunLogs`). Create one handle per CLI attempt and pass it to
   * `runAdapterExecutionTargetProcess` via `options.runLogTail`.
   */
  runLogTail?: SandboxRunLogTailFactory | null;
  stop(): Promise<void>;
}

export interface AdapterExecutionTargetProcessSessionBridgeHandle {
  agentCommand: string;
  stop(): Promise<void>;
}

export interface PaperclipControlPlaneProbeAttempt {
  url: string;
  status: number | null;
  location?: string;
  contentType?: string;
  error?: string;
}

export interface PaperclipControlPlaneProbeResult {
  ok: boolean;
  url?: string;
  status?: number;
  attempts: PaperclipControlPlaneProbeAttempt[];
}

export interface PreparePaperclipControlPlaneEnvResult {
  ok: boolean;
  skipped: boolean;
  changed: boolean;
  url: string | null;
  attempts: PaperclipControlPlaneProbeAttempt[];
  reasons: string[];
}

function applySelectedPaperclipApiUrl(env: Record<string, string>, url: string | null | undefined) {
  const selectedUrl = normalizePaperclipApiOrigin(url) ?? url?.trim() ?? "";
  if (!selectedUrl) return;
  env.PAPERCLIP_API_URL = selectedUrl;
  env.PAPERCLIP_RUNTIME_API_URL = selectedUrl;
}

export { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";

// 4-hour wall-clock backstop for sandbox-backed adapter runs. This is a
// last-resort kill switch, not the primary hang detector: genuinely hung runs
// are caught much earlier by the adapters' output-inactivity monitors (e.g.
// codex-local's 7-minute monitor). The value intentionally matches the
// recovery watchdog's ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS (4h) in
// server/src/services/recovery/service.ts so healthy long runs are never
// killed by the adapter before the watchdog would even consider them stuck.
export const DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC = 14_400;
const PAPERCLIP_CONTROL_PLANE_PREFLIGHT_ENV = "PAPERCLIP_CONTROL_PLANE_PREFLIGHT_JSON";
const PAPERCLIP_CONTROL_PLANE_PREFLIGHT_TIMEOUT_MS = 5_000;
const PAPERCLIP_CONTROL_PLANE_PREFLIGHT_TIMEOUT_PADDING_MS = 1_000;

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringMeta(parsed: Record<string, unknown>, key: string): string | null {
  return readString(parsed[key]);
}

function resolveHostForUrl(rawHost: string): string {
  const host = rawHost.trim();
  if (!host || host === "0.0.0.0" || host === "::") return "localhost";
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
  return host;
}

function resolveDefaultPaperclipApiUrl(): string {
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  // 3100 matches the default Paperclip dev server port when the runtime does not provide one.
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  return `http://${runtimeHost}:${runtimePort}`;
}

function normalizePaperclipApiOrigin(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function listPaperclipControlPlaneCandidates(env: Record<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined) => {
    const origin = normalizePaperclipApiOrigin(raw);
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    out.push(origin);
  };

  push(env.PAPERCLIP_API_URL);
  push(process.env.PAPERCLIP_RUNTIME_API_URL);
  const rawCandidates = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON?.trim();
  if (rawCandidates) {
    try {
      const parsed = JSON.parse(rawCandidates);
      if (Array.isArray(parsed)) {
        for (const candidate of parsed) {
          if (typeof candidate === "string") push(candidate);
        }
      }
    } catch {
      // Ignore malformed candidate lists and fall back to the primary env URL.
    }
  }
  // Local adapter runs still need a loopback escape hatch when the exported
  // public origin is behind an auth gateway and the runtime candidate list is
  // missing a host-local callback URL.
  push(resolveDefaultPaperclipApiUrl());

  return out;
}

function isPrivateOrLoopbackPaperclipApiHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedHost) return false;
  if (normalizedHost === "localhost" || normalizedHost.endsWith(".localhost")) return true;

  const ipFamily = net.isIP(normalizedHost);
  if (ipFamily === 4) {
    const octets = normalizedHost.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
    if (octets[0] === 127) return true;
    if (octets[0] === 10) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    return false;
  }

  if (ipFamily === 6) {
    return normalizedHost === "::1";
  }

  return false;
}

function isPrivateOrLoopbackPaperclipApiOrigin(origin: string): boolean {
  try {
    return isPrivateOrLoopbackPaperclipApiHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function selectFailOpenPaperclipApiUrl(env: Record<string, string>): string | null {
  const candidates = listPaperclipControlPlaneCandidates(env);
  const current = normalizePaperclipApiOrigin(env.PAPERCLIP_API_URL);
  if (current && isPrivateOrLoopbackPaperclipApiOrigin(current)) return current;
  return candidates.find((candidate) => isPrivateOrLoopbackPaperclipApiOrigin(candidate)) ?? current ?? candidates[0] ?? null;
}

function computePaperclipControlPlaneProbeTimeoutSec(candidates: string[], configuredTimeoutSec: number): number {
  const sequentialWorstCaseMs =
    candidates.length * PAPERCLIP_CONTROL_PLANE_PREFLIGHT_TIMEOUT_MS +
    PAPERCLIP_CONTROL_PLANE_PREFLIGHT_TIMEOUT_PADDING_MS;
  const sequentialWorstCaseSec = Math.max(5, Math.ceil(sequentialWorstCaseMs / 1_000));
  return configuredTimeoutSec > 0 ? Math.max(sequentialWorstCaseSec, configuredTimeoutSec) : sequentialWorstCaseSec;
}

function formatPaperclipControlPlaneAttemptSummary(attempt: PaperclipControlPlaneProbeAttempt): string {
  if (typeof attempt.status === "number") {
    const details = [attempt.contentType ?? null, attempt.location ?? null].filter(Boolean).join(", ");
    return details.length > 0 ? `${attempt.url} -> HTTP ${attempt.status} (${details})` : `${attempt.url} -> HTTP ${attempt.status}`;
  }
  if (attempt.error) return `${attempt.url} -> ${attempt.error}`;
  return `${attempt.url} -> unavailable`;
}

async function probePaperclipControlPlaneReachability(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  localProcessSandbox: LocalProcessSandboxOptions | null;
}): Promise<PaperclipControlPlaneProbeResult> {
  const candidates = listPaperclipControlPlaneCandidates(input.env);
  if (candidates.length === 0) {
    return { ok: false, attempts: [] };
  }
  const probeTimeoutSec = computePaperclipControlPlaneProbeTimeoutSec(candidates, input.timeoutSec);

  const probe = await runAdapterExecutionTargetProcess(
    `${input.runId}:paperclip-preflight`,
    input.target,
    process.execPath,
    [
      "-e",
      `
const candidates = JSON.parse(process.env.${PAPERCLIP_CONTROL_PLANE_PREFLIGHT_ENV} || "[]");
const auth = process.env.PAPERCLIP_API_KEY || "";
const attempts = [];
const timeoutMs = ${PAPERCLIP_CONTROL_PLANE_PREFLIGHT_TIMEOUT_MS};
const normalize = (value) => String(value || "").replace(/\\/+$/, "");
const run = async () => {
  for (const rawCandidate of candidates) {
    const candidate = normalize(rawCandidate);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(candidate + "/api/health", {
        method: "GET",
        headers: auth ? { authorization: "Bearer " + auth, accept: "application/json" } : { accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
      const location = response.headers.get("location");
      const contentType = response.headers.get("content-type");
      let body = null;
      if (contentType && contentType.toLowerCase().includes("application/json")) {
        try {
          body = await response.json();
        } catch {
          body = null;
        }
      }
      attempts.push({
        url: candidate,
        status: response.status,
        ...(location ? { location } : {}),
        ...(contentType ? { contentType } : {}),
      });
      const healthOk =
        body &&
        typeof body === "object" &&
        (
          body.status === "ok" ||
          body.ok === true
        );
      if (response.ok && contentType && contentType.toLowerCase().includes("application/json") && healthOk) {
        console.log(JSON.stringify({ ok: true, url: candidate, status: response.status, attempts }));
        return;
      }
    } catch (error) {
      attempts.push({
        url: candidate,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(JSON.stringify({ ok: false, attempts }));
  process.exitCode = 19;
};
run().catch((error) => {
  attempts.push({ url: "<probe>", status: null, error: error instanceof Error ? error.message : String(error) });
  console.log(JSON.stringify({ ok: false, attempts }));
  process.exitCode = 19;
});
      `.trim(),
    ],
    {
      cwd: input.cwd,
      env: {
        ...input.env,
        [PAPERCLIP_CONTROL_PLANE_PREFLIGHT_ENV]: JSON.stringify(candidates),
      },
      timeoutSec: probeTimeoutSec,
      graceSec: Math.max(1, Math.min(input.graceSec, 5)),
      onLog: async () => {},
      localProcessSandbox: input.localProcessSandbox,
    },
  );

  const lines = `${probe.stdout}\n${probe.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] ?? "") as PaperclipControlPlaneProbeResult;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.attempts)) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON noise and keep scanning for the final probe payload.
    }
  }

  const probeError =
    probe.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ||
    probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ||
    (probe.signal ? `probe_signal_${probe.signal}` : `probe_exit_${probe.exitCode}`);

  return {
    ok: false,
    attempts: candidates.map((url) => ({
      url,
      status: null,
      error: probeError,
    })),
  };
}

export async function preparePaperclipControlPlaneEnvForAdapterRun(input: {
  adapterLabel: string;
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  localProcessSandbox?: LocalProcessSandboxOptions | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<PreparePaperclipControlPlaneEnvResult> {
  const onLog = input.onLog ?? (async () => {});
  const reasons: string[] = [];
  const hasRuntimeApiConfiguration = Boolean(
    process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON?.trim() ||
      process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
      process.env.PAPERCLIP_API_URL?.trim(),
  );
  if (!input.env.PAPERCLIP_API_KEY?.trim()) reasons.push("missing_api_key");
  if (!hasRuntimeApiConfiguration) reasons.push("runtime_api_origin_unconfigured");
  if (input.env.PAPERCLIP_API_BRIDGE_MODE === "queue_v1") reasons.push("bridge_mode=queue_v1");
  const candidateCount = listPaperclipControlPlaneCandidates(input.env).length;
  if (candidateCount === 0) reasons.push("no_api_candidates");

  if (reasons.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Control-plane preflight skipped for this ${input.adapterLabel} run: ${reasons.join(", ")}.\n`,
    );
    return {
      ok: true,
      skipped: true,
      changed: false,
      url: input.env.PAPERCLIP_API_URL ?? null,
      attempts: [],
      reasons,
    };
  }

  await onLog(
    "stdout",
    `[paperclip] Control-plane preflight engaged for this ${input.adapterLabel} run. candidates=${candidateCount}.\n`,
  );

  const preflight = await probePaperclipControlPlaneReachability({
    runId: input.runId,
    target: input.target,
    cwd: input.cwd,
    env: input.env,
    timeoutSec: input.timeoutSec,
    graceSec: input.graceSec,
    localProcessSandbox: input.localProcessSandbox ?? null,
  });

  if (!preflight.ok || !preflight.url) {
    // Distinguish "the API is unreachable" from "the probe process itself
    // could not run" (spawn failure inside a sandbox target, killed by
    // timeout, etc. — surfaces as the synthesized probe_exit_*/probe_signal_*
    // error on every attempt). The latter proves nothing about reachability,
    // and failing the run on it froze the whole fleet on 2026-07-28 while the
    // control plane was fully healthy. Fail open: keep the previously
    // configured API URL and let the real run proceed.
    const probeInfraFailure =
      preflight.attempts.length > 0 &&
      preflight.attempts.every(
        (attempt) =>
          attempt.status === null &&
          typeof attempt.error === "string" &&
          (attempt.error.startsWith("probe_exit_") || attempt.error.startsWith("probe_signal_")),
      );
    if (probeInfraFailure) {
      const previousUrl = normalizePaperclipApiOrigin(input.env.PAPERCLIP_API_URL) ?? input.env.PAPERCLIP_API_URL ?? null;
      const failOpenUrl = selectFailOpenPaperclipApiUrl(input.env);
      const changed = failOpenUrl !== previousUrl;
      if (failOpenUrl) {
        applySelectedPaperclipApiUrl(input.env, failOpenUrl);
      }
      await onLog(
        "stdout",
        `[paperclip] Control-plane preflight probe could not execute for this ${input.adapterLabel} run ` +
          `(${preflight.attempts[0]?.error ?? "unknown"}); continuing without preflight ` +
          (failOpenUrl
            ? changed
              ? `(fail-open -> ${failOpenUrl} instead of ${previousUrl ?? "unset"}).\n`
              : `(fail-open -> ${failOpenUrl}).\n`
            : "(fail-open).\n"),
      );
      return {
        ok: true,
        skipped: true,
        changed,
        url: failOpenUrl,
        attempts: preflight.attempts,
        reasons: ["probe_infra_failure"],
      };
    }
    const attemptSummary =
      preflight.attempts.length > 0
        ? preflight.attempts.slice(0, 4).map(formatPaperclipControlPlaneAttemptSummary).join("; ")
        : "no Paperclip API candidates were exported to this adapter run";
    await onLog(
      "stdout",
      `[paperclip] Control-plane preflight failed for this ${input.adapterLabel} run. Tried: ${attemptSummary}\n`,
    );
    return {
      ok: false,
      skipped: false,
      changed: false,
      url: null,
      attempts: preflight.attempts,
      reasons: [],
    };
  }

  const previousUrl = input.env.PAPERCLIP_API_URL ?? null;
  const changed = preflight.url !== previousUrl;
  applySelectedPaperclipApiUrl(input.env, preflight.url);
  await onLog(
    "stdout",
    changed
      ? `[paperclip] Selected reachable Paperclip API URL ${preflight.url} for this ${input.adapterLabel} run.\n`
      : `[paperclip] Control-plane preflight confirmed ${preflight.url} is reachable for this ${input.adapterLabel} run.\n`,
  );
  return {
    ok: true,
    skipped: false,
    changed,
    url: preflight.url,
    attempts: preflight.attempts,
    reasons: [],
  };
}

function isBridgeDebugEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PAPERCLIP_BRIDGE_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isAdapterExecutionTargetInstance(value: unknown): value is AdapterExecutionTarget {
  const parsed = parseObject(value);
  if (parsed.kind === "local") return true;
  if (parsed.kind !== "remote") return false;
  if (parsed.transport === "ssh") return parseSshRemoteExecutionSpec(parseObject(parsed.spec)) !== null;
  if (parsed.transport !== "sandbox") return false;
  return readStringMeta(parsed, "remoteCwd") !== null;
}

export function adapterExecutionTargetToRemoteSpec(
  target: AdapterExecutionTarget | null | undefined,
): AdapterRemoteExecutionSpec | null {
  return target?.kind === "remote" && target.transport === "ssh" ? target.spec : null;
}

export function adapterExecutionTargetIsRemote(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return target?.kind === "remote";
}

export function adapterExecutionTargetUsesManagedHome(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return target?.kind === "remote" && target.transport === "sandbox";
}

export function adapterExecutionTargetRemoteCwd(
  target: AdapterExecutionTarget | null | undefined,
  localCwd: string,
): string {
  return target?.kind === "remote" ? target.remoteCwd : localCwd;
}

export function overrideAdapterExecutionTargetRemoteCwd(
  target: AdapterExecutionTarget | null | undefined,
  remoteCwd: string | null | undefined,
): AdapterExecutionTarget | null | undefined {
  const nextRemoteCwd = remoteCwd?.trim();
  if (!target || target.kind !== "remote" || !nextRemoteCwd) {
    return target;
  }
  if (target.remoteCwd === nextRemoteCwd) {
    return target;
  }
  if (target.transport === "ssh") {
    return {
      ...target,
      remoteCwd: nextRemoteCwd,
      spec: {
        ...target.spec,
        remoteCwd: nextRemoteCwd,
      },
    };
  }
  return {
    ...target,
    remoteCwd: nextRemoteCwd,
  };
}

export function resolveAdapterExecutionTargetCwd(
  target: AdapterExecutionTarget | null | undefined,
  configuredCwd: string | null | undefined,
  localFallbackCwd: string,
): string {
  if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) {
    return configuredCwd;
  }
  return adapterExecutionTargetRemoteCwd(target, localFallbackCwd);
}

export function adapterExecutionTargetUsesPaperclipBridge(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return target?.kind === "remote";
}

export function describeAdapterExecutionTarget(
  target: AdapterExecutionTarget | null | undefined,
): string {
  if (!target || target.kind === "local") return "local environment";
  if (target.transport === "ssh") {
    return `SSH environment ${target.spec.username}@${target.spec.host}:${target.spec.port}`;
  }
  return `sandbox environment${target.providerKey ? ` (${target.providerKey})` : ""}`;
}

export type AdapterExecutionTargetTimeoutSource =
  | "configured"
  | "sandbox_default"
  | "unlimited";

export interface AdapterExecutionTargetTimeoutResolution {
  /** Resolved wall-clock timeout in seconds; 0 means no adapter timeout. */
  timeoutSec: number;
  /** Which knob produced the resolved value, for logs and error messages. */
  source: AdapterExecutionTargetTimeoutSource;
}

export function resolveAdapterExecutionTargetTimeout(
  target: AdapterExecutionTarget | null | undefined,
  configuredTimeoutSec: number | null | undefined,
): AdapterExecutionTargetTimeoutResolution {
  if (typeof configuredTimeoutSec === "number" && Number.isFinite(configuredTimeoutSec)) {
    // Preserve fractional (sub-second) configured values instead of flooring:
    // adapters historically honored e.g. timeoutSec=0.5, and flooring would
    // silently turn it into "no timeout".
    if (configuredTimeoutSec > 0) {
      return { timeoutSec: configuredTimeoutSec, source: "configured" };
    }
    // A negative timeoutSec is the explicit "no adapter wall-clock timeout"
    // opt-out, honored even on sandbox targets. Zero cannot carry that
    // meaning: the adapter config UI persists the schema default of 0 for
    // untouched fields, so timeoutSec=0 in stored config does not signal
    // operator intent and falls through to target defaults below.
    if (configuredTimeoutSec < 0) {
      return { timeoutSec: 0, source: "configured" };
    }
  }
  // Local and SSH adapters preserve the historical "0 means no adapter
  // timeout" behavior. Sandbox-backed runs execute through provider RPCs
  // that usually apply their own shorter command defaults, so request an
  // explicit longer timeout for full adapter runs when the adapter leaves
  // timeoutSec unset.
  if (target?.kind === "remote" && target.transport === "sandbox") {
    return { timeoutSec: DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC, source: "sandbox_default" };
  }
  return { timeoutSec: 0, source: "unlimited" };
}

export function resolveAdapterExecutionTargetTimeoutSec(
  target: AdapterExecutionTarget | null | undefined,
  configuredTimeoutSec: number | null | undefined,
): number {
  return resolveAdapterExecutionTargetTimeout(target, configuredTimeoutSec).timeoutSec;
}

function describeAdapterExecutionTimeoutSource(
  source: AdapterExecutionTargetTimeoutSource,
): string {
  switch (source) {
    case "configured":
      return "configured via adapterConfig.timeoutSec";
    case "sandbox_default":
      return "sandbox default";
    case "unlimited":
      return "no adapter wall-clock timeout";
  }
}

/**
 * Self-describing error message for when the adapter wall-clock execution
 * timeout kills a run. Names the timer that fired and the knob that controls
 * it so run failures never surface as a bare "Timed out".
 */
export function formatAdapterExecutionTimeoutErrorMessage(
  resolution: AdapterExecutionTargetTimeoutResolution,
): string {
  return (
    `Run exceeded the adapter execution timeout ` +
    `(timeoutSec=${resolution.timeoutSec}, ${describeAdapterExecutionTimeoutSource(resolution.source)}). ` +
    `Set adapterConfig.timeoutSec to raise it.`
  );
}

/**
 * One-line start-of-run statement of the effective wall-clock timeout and its
 * source. Callers prefix with `[paperclip] ` and append a newline.
 */
export function formatAdapterExecutionTimeoutStartLogLine(
  resolution: AdapterExecutionTargetTimeoutResolution,
): string {
  if (resolution.timeoutSec <= 0) {
    if (resolution.source === "configured") {
      return (
        "Adapter execution timeout: none " +
        "(explicitly disabled via adapterConfig.timeoutSec; set it to a positive value to add one)."
      );
    }
    return (
      "Adapter execution timeout: none " +
      "(no adapter wall-clock timeout for this target; set adapterConfig.timeoutSec to add one)."
    );
  }
  return (
    `Adapter execution timeout: timeoutSec=${resolution.timeoutSec} ` +
    `(${describeAdapterExecutionTimeoutSource(resolution.source)}; set adapterConfig.timeoutSec to override).`
  );
}

function requireSandboxRunner(target: AdapterSandboxExecutionTarget): CommandManagedRuntimeRunner {
  if (target.runner) return target.runner;
  throw new Error(
    "Sandbox execution target is missing its provider runtime runner. Sandbox commands must execute through the environment runtime.",
  );
}

function preferredSandboxShell(target: AdapterSandboxExecutionTarget): "bash" | "sh" {
  return preferredShellForSandbox(target.shellCommand);
}

type AdapterCommandCapableExecutionTarget = AdapterSshExecutionTarget | AdapterSandboxExecutionTarget;

function adapterExecutionTargetCommandRunner(target: AdapterCommandCapableExecutionTarget): CommandManagedRuntimeRunner {
  if (target.transport === "ssh") {
    return createSshCommandManagedRuntimeRunner({
      spec: target.spec,
      defaultCwd: target.remoteCwd,
      maxBufferBytes: DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES * 4,
    });
  }
  return requireSandboxRunner(target);
}

function adapterExecutionTargetShellCommand(target: AdapterCommandCapableExecutionTarget): "bash" | "sh" {
  return target.transport === "ssh" ? "sh" : preferredSandboxShell(target);
}

function adapterExecutionTargetTimeoutMs(
  target: AdapterCommandCapableExecutionTarget,
): number | null | undefined {
  return target.transport === "sandbox" ? target.timeoutMs : undefined;
}

export async function ensureAdapterExecutionTargetCommandResolvable(
  command: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { installCommand?: string | null; timeoutSec?: number | null } = {},
) {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    await ensureSandboxCommandResolvable(
      command,
      target,
      options.installCommand?.trim() || null,
      options.timeoutSec,
    );
    return;
  }
  await ensureCommandResolvable(command, cwd, env, {
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
}

async function probeSandboxCommandResolvable(
  command: string,
  target: AdapterSandboxExecutionTarget,
): Promise<{ resolved: boolean; timedOut: boolean; stderr: string }> {
  const runner = requireSandboxRunner(target);
  const probeScript = `command -v ${shellQuote(command)}`;
  const result = await runner.execute({
    command: "sh",
    args: ["-c", probeScript],
    cwd: target.remoteCwd,
    timeoutMs: target.timeoutMs ?? 15_000,
  });
  return {
    resolved: !result.timedOut && (result.exitCode ?? 1) === 0,
    timedOut: result.timedOut,
    stderr: result.stderr.trim(),
  };
}

async function ensureSandboxCommandResolvable(
  command: string,
  target: AdapterSandboxExecutionTarget,
  installCommand: string | null,
  timeoutSec?: number | null,
): Promise<void> {
  // Probe whether the binary is resolvable inside the sandbox. We previously
  // short-circuited this for sandbox targets, which let the caller report a
  // success message even when the CLI was missing from the image. Now we run
  // a real `command -v` through the same runner the hello probe will use, so
  // the first step honestly reflects whether the binary is on PATH. The
  // sandbox provider is responsible for sourcing login profiles (e2b mirrors
  // SSH's buildSshSpawnTarget) so this and the hello probe agree on PATH.
  let probe = await probeSandboxCommandResolvable(command, target);
  if (probe.resolved) return;
  if (probe.timedOut) {
    throw new Error(`Timed out checking command "${command}" on sandbox target.`);
  }

  // If the caller supplied an install command, attempt the install once via
  // the sandbox runner (which the sandbox provider wraps in a login shell)
  // and re-probe before reporting failure. This lets fresh sandbox leases
  // bring up the CLI before the resolvability gate, mirroring the test path.
  let installFailureDetail: string | null = null;
  if (installCommand) {
    const runner = requireSandboxRunner(target);
    const installTimeoutMs =
      typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0
        ? Math.floor(timeoutSec * 1000)
        : target.timeoutMs ?? 300_000;
    try {
      const installResult = await runner.execute({
        command: "sh",
        args: shellCommandArgs(installCommand),
        cwd: target.remoteCwd,
        timeoutMs: installTimeoutMs,
      });
      if (installResult.timedOut) {
        installFailureDetail = `install command timed out: ${installCommand}`;
      } else if ((installResult.exitCode ?? 0) !== 0) {
        const tail = (text: string) =>
          text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-2).join(" | ").slice(0, 240);
        const reason = tail(installResult.stderr || installResult.stdout) || `exit ${installResult.exitCode ?? "?"}`;
        installFailureDetail = `install command exited ${installResult.exitCode ?? "?"}: ${reason}`;
      }
    } catch (err) {
      installFailureDetail = `install command threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    probe = await probeSandboxCommandResolvable(command, target);
    if (probe.resolved) return;
    if (probe.timedOut) {
      throw new Error(`Timed out checking command "${command}" on sandbox target.`);
    }
  }

  const probeStderr = probe.stderr.length > 0 ? ` probe stderr: ${probe.stderr}` : "";
  const installDetail = installFailureDetail ? `; ${installFailureDetail}` : "";
  throw new Error(
    `Command "${command}" is not installed or not on PATH in the sandbox environment${installDetail}.${probeStderr}`,
  );
}

export async function resolveAdapterExecutionTargetCommandForLogs(
  command: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    return `sandbox://${target.providerKey ?? "provider"}/${target.leaseId ?? "lease"}/${target.remoteCwd} :: ${command}`;
  }
  return await resolveCommandForLogs(command, cwd, env, {
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
}

export async function runAdapterExecutionTargetProcess(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  command: string,
  args: string[],
  options: AdapterExecutionTargetProcessOptions,
): Promise<RunProcessResult> {
  if (target?.kind === "remote" && target.transport === "sandbox") {
    const runner = requireSandboxRunner(target);
    const env = sanitizeRemoteExecutionEnv(options.env);
    await options.onRuntimeProgress?.({
      phase: "adapter_startup",
      message: "Starting adapter in sandbox",
    });
    const runLogTail = options.runLogTail?.create() ?? null;
    let execCommand = command;
    let execArgs = args;
    if (runLogTail) {
      ({ command: execCommand, args: execArgs } = runLogTail.wrapCommand(command, args));
      runLogTail.start(options.onLog);
    }
    try {
      const result = await runner.execute({
        command: execCommand,
        args: execArgs,
        cwd: target.remoteCwd,
        env,
        stdin: options.stdin,
        timeoutMs: options.timeoutSec > 0 ? options.timeoutSec * 1000 : target.timeoutMs ?? undefined,
        // The tail loop already streams incremental chunks; suppress the
        // runner's end-of-run batched onLog to avoid duplicate log bytes.
        onLog: runLogTail ? undefined : options.onLog,
        onSpawn: options.onSpawn
          ? async (meta) => options.onSpawn?.({ ...meta, processGroupId: null })
          : undefined,
      });
      if (runLogTail) {
        await runLogTail.finish({ stdout: result.stdout, stderr: result.stderr });
      }
      return result;
    } catch (error) {
      if (runLogTail) {
        await runLogTail.abort();
      }
      throw error;
    }
  }

  const env =
    target?.kind === "remote" && target.transport === "ssh"
      ? sanitizeRemoteExecutionEnv(options.env)
      : options.env;

  return await runChildProcess(runId, command, args, {
    cwd: options.cwd,
    env,
    stdin: options.stdin,
    timeoutSec: options.timeoutSec,
    graceSec: options.graceSec,
    onLog: options.onLog,
    onSpawn: options.onSpawn,
    terminalResultCleanup: options.terminalResultCleanup,
    localProcessSandbox: target?.kind === "local" || !target ? options.localProcessSandbox : null,
    remoteExecution: adapterExecutionTargetToRemoteSpec(target),
  });
}

export async function runAdapterExecutionTargetShellCommand(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  command: string,
  options: AdapterExecutionTargetShellOptions,
): Promise<RunProcessResult> {
  const onLog = options.onLog ?? (async () => {});
  if (target?.kind === "remote") {
    const startedAt = new Date().toISOString();
    const env = sanitizeRemoteExecutionEnv(options.env);
    if (target.transport === "ssh") {
      try {
        // Pass the raw command — `runSshCommand` owns profile sourcing and
        // the outer shell wrapper. Wrapping again here would nest a second
        // shell after the explicit `env KEY=VAL` overrides, re-sourcing
        // login profiles AFTER the override and silently undoing any
        // identity var (NVM_DIR / PATH / etc.) that a profile re-exports.
        const result = await runSshCommand(target.spec, command, {
          env,
          timeoutMs: (options.timeoutSec ?? 15) * 1000,
        });
        if (result.stdout) await onLog("stdout", result.stdout);
        if (result.stderr) await onLog("stderr", result.stderr);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt,
        };
      } catch (error) {
        const timedOutError = error as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
          signal?: string | null;
        };
        const stdout = timedOutError.stdout ?? "";
        const stderr = timedOutError.stderr ?? "";
        if (typeof timedOutError.code === "number") {
          if (stdout) await onLog("stdout", stdout);
          if (stderr) await onLog("stderr", stderr);
          return {
            exitCode: timedOutError.code,
            signal: timedOutError.signal ?? null,
            timedOut: false,
            stdout,
            stderr,
            pid: null,
            startedAt,
          };
        }
        if (timedOutError.code !== "ETIMEDOUT") {
          throw error;
        }
        if (stdout) await onLog("stdout", stdout);
        if (stderr) await onLog("stderr", stderr);
        return {
          exitCode: null,
          signal: timedOutError.signal ?? null,
          timedOut: true,
          stdout,
          stderr,
          pid: null,
          startedAt,
        };
      }
    }

    const shellCommand = preferredSandboxShell(target);
    return await requireSandboxRunner(target).execute({
      command: shellCommand,
      args: shellCommandArgs(command),
      cwd: target.remoteCwd,
      env,
      timeoutMs: (options.timeoutSec ?? 15) * 1000,
      onLog,
    });
  }

  return await runAdapterExecutionTargetProcess(
    runId,
    target,
    "sh",
    ["-lc", command],
    {
      cwd: options.cwd,
      env: options.env,
      timeoutSec: options.timeoutSec ?? 15,
      graceSec: options.graceSec ?? 5,
      onLog,
    },
  );
}

export interface AdapterSandboxInstallCommandCheck {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
  hint?: string;
}

// Best-effort run of an adapter-supplied install command on a sandbox target
// before the resolvability + hello probe. Returns null for non-sandbox
// targets so callers can no-op. Returns a structured check otherwise — never
// throws — so the rest of the test still runs and reports the post-install
// state honestly. Caller pushes the check into its result array; the test
// report shows whether install was attempted and what came back.
export async function maybeRunSandboxInstallCommand(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  adapterKey: string;
  installCommand: string;
  /** When provided, skip the install if `command -v <detectCommand>` succeeds. */
  detectCommand?: string | null;
  env?: Record<string, string>;
  timeoutSec?: number;
}): Promise<AdapterSandboxInstallCommandCheck | null> {
  const { target, adapterKey, installCommand } = input;
  if (!target || target.kind !== "remote" || target.transport !== "sandbox") {
    return null;
  }
  const trimmed = installCommand.trim();
  if (trimmed.length === 0) return null;

  const code = `${adapterKey}_install_command_run`;

  // Skip install when the binary is already on PATH. Avoids running
  // network-dependent installers (e.g. `curl ... | bash`) on every test
  // probe when the CLI is preinstalled on the lease/template.
  const detectCommand = input.detectCommand?.trim();
  if (detectCommand) {
    try {
      const probe = await runAdapterExecutionTargetShellCommand(
        input.runId,
        target,
        `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`,
        {
          cwd: target.remoteCwd,
          env: input.env ?? {},
          timeoutSec: 30,
          graceSec: 5,
        },
      );
      if (!probe.timedOut && probe.exitCode === 0) {
        return {
          code,
          level: "info",
          message: `${detectCommand} already on PATH; skipped install.`,
        };
      }
    } catch {
      // Fall through to actually running the install — failure to probe
      // is not a reason to skip the install gate.
    }
  }

  let result;
  try {
    result = await runAdapterExecutionTargetShellCommand(input.runId, target, trimmed, {
      cwd: target.remoteCwd,
      env: input.env ?? {},
      timeoutSec: input.timeoutSec ?? 240,
      graceSec: 10,
    });
  } catch (err) {
    return {
      code,
      level: "warn",
      message: "Install command threw before completion.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const tail = (text: string) =>
    text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-3).join(" | ").slice(0, 480);
  if (result.timedOut) {
    return {
      code,
      level: "warn",
      message: `Install command timed out: ${trimmed}`,
      detail: tail(result.stderr || result.stdout),
    };
  }
  if ((result.exitCode ?? 1) === 0) {
    return {
      code,
      level: "info",
      message: `Install command ran: ${trimmed}`,
      ...(tail(result.stdout) ? { detail: tail(result.stdout) } : {}),
    };
  }
  return {
    code,
    level: "warn",
    message: `Install command exited ${result.exitCode}: ${trimmed}`,
    detail: tail(result.stderr || result.stdout),
  };
}

export async function readAdapterExecutionTargetHomeDir(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  options: AdapterExecutionTargetShellOptions,
): Promise<string | null> {
  const result = await runAdapterExecutionTargetShellCommand(
    runId,
    target,
    'printf %s "$HOME"',
    options,
  );
  const homeDir = result.stdout.trim();
  return homeDir.length > 0 ? homeDir : null;
}

export async function ensureAdapterExecutionTargetRuntimeCommandInstalled(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  installCommand?: string | null;
  detectCommand?: string | null;
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  onLog?: AdapterExecutionTargetShellOptions["onLog"];
}): Promise<void> {
  const installCommand = input.installCommand?.trim();
  if (!installCommand || input.target?.kind !== "remote" || input.target.transport !== "sandbox") {
    return;
  }

  const detectCommand = input.detectCommand?.trim();
  if (detectCommand) {
    const probe = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      },
    );
    if (!probe.timedOut && probe.exitCode === 0) {
      return;
    }
  }

  const result = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    installCommand,
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
      graceSec: input.graceSec,
      onLog: input.onLog,
    },
  );

  // A failed or timed-out install is not necessarily fatal: the CLI may already
  // be on PATH from a previous lease's install, the template image, or another
  // path entry. Re-run the detect probe (when one is configured) so a transient
  // install failure does not abort the agent run when the binary is reachable.
  const installFailed = result.timedOut || (result.exitCode ?? 0) !== 0;
  if (!installFailed) {
    return;
  }
  if (detectCommand) {
    const recheck = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `command -v ${shellQuote(detectCommand)} >/dev/null 2>&1`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      },
    );
    if (!recheck.timedOut && recheck.exitCode === 0) {
      if (input.onLog) {
        const reason = result.timedOut ? "timed out" : `exited ${result.exitCode ?? "?"}`;
        await input.onLog(
          "stderr",
          `[paperclip] Install command ${reason} (${installCommand}) but ${detectCommand} is on PATH; continuing.\n`,
        );
      }
      return;
    }
  }

  if (result.timedOut) {
    throw new Error(`Timed out while installing the adapter runtime command via: ${installCommand}`);
  }
  throw new Error(`Failed to install the adapter runtime command via: ${installCommand}`);
}

export async function ensureAdapterExecutionTargetFile(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  filePath: string,
  options: AdapterExecutionTargetShellOptions,
): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    runId,
    target,
    `mkdir -p ${shellQuote(path.posix.dirname(filePath))} && : > ${shellQuote(filePath)}`,
    options,
  );
}

/**
 * Ensure a working directory exists (and is a directory) on the execution target.
 *
 * For local targets this delegates to the local `ensureAbsoluteDirectory` helper
 * (Node fs). For remote (SSH/sandbox) targets it shells out and runs
 * `mkdir -p` (when allowed) followed by a `[ -d ]` check so the result reflects
 * the directory state inside the environment, not on the Paperclip host.
 *
 * Throws an Error with a human-readable message on failure.
 */
export async function ensureAdapterExecutionTargetDirectory(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  options: AdapterExecutionTargetShellOptions & { createIfMissing?: boolean },
): Promise<void> {
  const createIfMissing = options.createIfMissing ?? false;

  if (!target || target.kind === "local") {
    const { ensureAbsoluteDirectory } = await import("./server-utils.js");
    await ensureAbsoluteDirectory(cwd, { createIfMissing });
    return;
  }

  // Remote (SSH or sandbox): both expect POSIX absolute paths inside the env.
  if (!cwd.startsWith("/")) {
    throw new Error(`Working directory must be an absolute POSIX path on the remote target: "${cwd}"`);
  }

  const quoted = shellQuote(cwd);
  const script = createIfMissing
    ? `mkdir -p ${quoted} && [ -d ${quoted} ]`
    : `[ -d ${quoted} ]`;

  const result = await runAdapterExecutionTargetShellCommand(runId, target, script, {
    cwd: target.kind === "remote" ? target.remoteCwd : cwd,
    env: options.env,
    timeoutSec: options.timeoutSec ?? 15,
    graceSec: options.graceSec ?? 5,
    onLog: options.onLog,
  });

  if (result.timedOut) {
    throw new Error(`Timed out checking working directory on remote target: "${cwd}"`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    if (createIfMissing) {
      throw new Error(
        `Could not create working directory "${cwd}" on remote target${detail ? `: ${detail}` : "."}`,
      );
    }
    throw new Error(
      `Working directory does not exist on remote target: "${cwd}"${detail ? ` (${detail})` : ""}`,
    );
  }
}

export function adapterExecutionTargetSessionIdentity(
  target: AdapterExecutionTarget | null | undefined,
): Record<string, unknown> | null {
  if (!target || target.kind === "local") return null;
  if (target.transport === "ssh") return buildRemoteExecutionSessionIdentity(target.spec);
  return {
    transport: "sandbox",
    providerKey: target.providerKey ?? null,
    environmentId: target.environmentId ?? null,
    leaseId: target.leaseId ?? null,
    remoteCwd: target.remoteCwd,
  };
}

export function adapterExecutionTargetSessionMatches(
  saved: unknown,
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  if (!target || target.kind === "local") {
    return Object.keys(parseObject(saved)).length === 0;
  }
  if (target.transport === "ssh") return remoteExecutionSessionMatches(saved, target.spec);
  const current = adapterExecutionTargetSessionIdentity(target);
  const parsedSaved = parseObject(saved);
  return (
    readStringMeta(parsedSaved, "transport") === current?.transport &&
    readStringMeta(parsedSaved, "providerKey") === current?.providerKey &&
    readStringMeta(parsedSaved, "environmentId") === current?.environmentId &&
    readStringMeta(parsedSaved, "leaseId") === current?.leaseId &&
    readStringMeta(parsedSaved, "remoteCwd") === current?.remoteCwd
  );
}

export function parseAdapterExecutionTarget(value: unknown): AdapterExecutionTarget | null {
  const parsed = parseObject(value);
  const kind = readStringMeta(parsed, "kind");

  if (kind === "local") {
    return {
      kind: "local",
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
    };
  }

  if (kind === "remote" && readStringMeta(parsed, "transport") === "ssh") {
    const spec = parseSshRemoteExecutionSpec(parseObject(parsed.spec));
    if (!spec) return null;
    return {
      kind: "remote",
      transport: "ssh",
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
      remoteCwd: spec.remoteCwd,
      spec,
    };
  }

  if (kind === "remote" && readStringMeta(parsed, "transport") === "sandbox") {
    const remoteCwd = readStringMeta(parsed, "remoteCwd");
    if (!remoteCwd) return null;
    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: readStringMeta(parsed, "providerKey"),
      environmentId: readStringMeta(parsed, "environmentId"),
      leaseId: readStringMeta(parsed, "leaseId"),
      remoteCwd,
      timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : null,
      streamRunLogs: typeof parsed.streamRunLogs === "boolean" ? parsed.streamRunLogs : null,
    };
  }

  return null;
}

export function adapterExecutionTargetFromRemoteExecution(
  remoteExecution: unknown,
  metadata: Pick<AdapterLocalExecutionTarget, "environmentId" | "leaseId"> = {},
): AdapterExecutionTarget | null {
  const parsed = parseObject(remoteExecution);
  const ssh = parseSshRemoteExecutionSpec(parsed);
  if (ssh) {
    return {
      kind: "remote",
      transport: "ssh",
      environmentId: metadata.environmentId ?? null,
      leaseId: metadata.leaseId ?? null,
      remoteCwd: ssh.remoteCwd,
      spec: ssh,
    };
  }

  return null;
}

export function readAdapterExecutionTarget(input: {
  executionTarget?: unknown;
  legacyRemoteExecution?: unknown;
}): AdapterExecutionTarget | null {
  if (isAdapterExecutionTargetInstance(input.executionTarget)) {
    return input.executionTarget;
  }
  return (
    parseAdapterExecutionTarget(input.executionTarget) ??
    adapterExecutionTargetFromRemoteExecution(input.legacyRemoteExecution)
  );
}

export async function prepareAdapterExecutionTargetRuntime(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  adapterKey: string;
  workspaceLocalDir: string;
  timeoutSec?: number;
  workspaceRemoteDir?: string;
  workspaceExclude?: string[];
  preserveAbsentOnRestore?: string[];
  assets?: AdapterManagedRuntimeAsset[];
  installCommand?: string | null;
  /** When provided alongside `installCommand`, skip the install if the binary is already on PATH. */
  detectCommand?: string | null;
  // Optional progress sink for the workspace/asset upload. The returned
  // `restoreWorkspace(onProgress?)` accepts its own sink for teardown. Both are
  // forwarded down to the transport so the sandbox/SSH children can attach byte
  // counters without further changes here.
  onProgress?: RuntimeProgressSink;
  onRuntimeProgress?: RuntimeStatusSink;
}): Promise<PreparedAdapterExecutionTargetRuntime> {
  const target = input.target ?? { kind: "local" as const };
  if (target.kind === "local") {
    return {
      target,
      workspaceRemoteDir: null,
      runtimeRootDir: null,
      assetDirs: {},
      restoreWorkspace: async () => {},
    };
  }

  if (target.transport === "ssh") {
    const prepared = await prepareRemoteManagedRuntime({
      spec: target.spec,
      runId: input.runId,
      adapterKey: input.adapterKey,
      workspaceLocalDir: input.workspaceLocalDir,
      workspaceRemoteDir: input.workspaceRemoteDir,
      assets: input.assets,
      onProgress: input.onProgress,
    });
    return {
      target,
      workspaceRemoteDir: prepared.workspaceRemoteDir,
      runtimeRootDir: prepared.runtimeRootDir,
      assetDirs: prepared.assetDirs,
      restoreWorkspace: prepared.restoreWorkspace,
    };
  }

  const prepared = await prepareCommandManagedRuntime({
    runner: requireSandboxRunner(target),
    spec: {
      providerKey: target.providerKey,
      shellCommand: target.shellCommand,
      leaseId: target.leaseId,
      remoteCwd: target.remoteCwd,
      timeoutMs:
        input.timeoutSec && input.timeoutSec > 0
          ? input.timeoutSec * 1000
          : target.timeoutMs,
    },
    adapterKey: input.adapterKey,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir: input.workspaceRemoteDir,
    workspaceExclude: input.workspaceExclude,
    preserveAbsentOnRestore: input.preserveAbsentOnRestore,
    assets: input.assets,
    installCommand: input.installCommand,
    detectCommand: input.detectCommand,
    onProgress: input.onProgress,
    onRuntimeProgress: input.onRuntimeProgress,
  });
  return {
    target,
    workspaceRemoteDir: prepared.workspaceRemoteDir,
    runtimeRootDir: prepared.runtimeRootDir,
    assetDirs: prepared.assetDirs,
    restoreWorkspace: prepared.restoreWorkspace,
  };
}

export function runtimeAssetDir(
  prepared: Pick<PreparedAdapterExecutionTargetRuntime, "assetDirs">,
  key: string,
  fallbackRemoteCwd: string,
): string {
  return prepared.assetDirs[key] ?? path.posix.join(fallbackRemoteCwd, ".paperclip-runtime", key);
}

function buildBridgeResponseHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["content-type", "etag", "last-modified"]) {
    const value = response.headers.get(key);
    if (value && value.trim().length > 0) out[key] = value.trim();
  }
  return out;
}

function buildBridgeForwardUrl(baseUrl: string, request: { path: string; query: string }): URL {
  const url = new URL(request.path, baseUrl);
  const query = request.query.trim();
  url.search = query.startsWith("?") ? query.slice(1) : query;
  return url;
}

function bridgeResponseBodyLimitError(maxBodyBytes: number): Error {
  return new Error(`Bridge response body exceeded the configured size limit of ${maxBodyBytes} bytes.`);
}

async function readBridgeForwardResponseBody(response: Response, maxBodyBytes: number): Promise<string> {
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength) {
    const contentLength = Number.parseInt(rawContentLength, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      throw bridgeResponseBodyLimitError(maxBodyBytes);
    }
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      throw bridgeResponseBodyLimitError(maxBodyBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

const PROCESS_SESSION_PROXY_SCRIPT = "paperclip-process-session-proxy.mjs";
const PROCESS_SESSION_REMOTE_SCRIPT = "paperclip-process-session-remote.mjs";
const PROCESS_SESSION_AUTH_TIMEOUT_MS = 5_000;

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function splitJsonLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\n/);
  return { lines: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}

async function writeProcessSessionProxyScript(dir: string, port: number, token: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const proxyPath = path.join(dir, PROCESS_SESSION_PROXY_SCRIPT);
  await fs.writeFile(proxyPath, getProcessSessionProxySource({ port, token }), { mode: 0o700 });
  return proxyPath;
}

async function syncProcessSessionRemoteScript(input: {
  client: ReturnType<typeof createCommandManagedSandboxCallbackBridgeQueueClient>;
  remoteScriptPath: string;
}): Promise<void> {
  await input.client.writeTextFile(input.remoteScriptPath, getProcessSessionRemoteSource());
}

async function readRemoteJsonFiles(input: {
  client: ReturnType<typeof createCommandManagedSandboxCallbackBridgeQueueClient>;
  dir: string;
}): Promise<Array<{ name: string; body: string }>> {
  const names = await input.client.listJsonFiles(input.dir);
  const out: Array<{ name: string; body: string }> = [];
  for (const name of names) {
    const filePath = path.posix.join(input.dir, name);
    const body = await input.client.readTextFile(filePath);
    await input.client.remove(filePath).catch(() => undefined);
    out.push({ name, body });
  }
  return out;
}

async function waitForLocalServerListen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Process session bridge did not expose a TCP port.");
  }
  return address.port;
}

export async function startAdapterExecutionTargetProcessSessionBridge(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  runtimeRootDir: string | null | undefined;
  adapterKey: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<AdapterExecutionTargetProcessSessionBridgeHandle | null> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return null;
  }

  const target = input.target;
  const onLog = input.onLog ?? (async () => {});
  const runner = requireSandboxRunner(target);
  const shellCommand = preferredSandboxShell(target);
  const timeoutMs =
    typeof input.timeoutSec === "number" && Number.isFinite(input.timeoutSec) && input.timeoutSec > 0
      ? Math.trunc(input.timeoutSec * 1000)
      : target.timeoutMs ?? undefined;
  const bridgeRuntimeDir = path.posix.join(
    input.runtimeRootDir?.trim() || path.posix.join(target.remoteCwd, ".paperclip-runtime", input.adapterKey),
    "process-sessions",
  );
  const sessionId = randomUUID();
  const sessionDir = path.posix.join(bridgeRuntimeDir, sessionId);
  const stdinDir = path.posix.join(sessionDir, "stdin");
  const eventsDir = path.posix.join(sessionDir, "events");
  const remoteScriptPath = path.posix.join(bridgeRuntimeDir, PROCESS_SESSION_REMOTE_SCRIPT);
  const client = createCommandManagedSandboxCallbackBridgeQueueClient({
    runner,
    remoteCwd: target.remoteCwd,
    timeoutMs,
    shellCommand,
  });

  await client.makeDir(stdinDir);
  await client.makeDir(eventsDir);
  await syncProcessSessionRemoteScript({ client, remoteScriptPath });

  const commandPayload = Buffer.from(JSON.stringify({
    command: input.command,
    args: input.args,
    cwd: input.cwd || target.remoteCwd,
    env: sanitizeRemoteExecutionEnv(input.env),
  }), "utf8").toString("base64");

  await onLog("stdout", `[paperclip] Starting ACP process session bridge in sandbox (${target.providerKey ?? "provider"}).\n`);
  const startResult = await runner.execute({
    command: shellCommand,
    args: shellCommandArgs(
      [
        `mkdir -p ${shellQuote(stdinDir)} ${shellQuote(eventsDir)}`,
        `PAPERCLIP_PROCESS_SESSION_DIR=${shellQuote(sessionDir)} ` +
          `PAPERCLIP_PROCESS_SESSION_COMMAND_B64=${shellQuote(commandPayload)} ` +
          `nohup node ${shellQuote(remoteScriptPath)} >/dev/null 2>&1 < /dev/null &`,
        "printf '%s\\n' \"$!\"",
      ].join("\n"),
    ),
    cwd: target.remoteCwd,
    env: {
      PAPERCLIP_SANDBOX_EXEC_CHANNEL: "bridge",
    },
    timeoutMs,
  });
  if (startResult.timedOut || (startResult.exitCode ?? 1) !== 0) {
    throw new Error(`Failed to start sandbox ACP process session bridge: ${startResult.stderr || startResult.stdout}`);
  }

  let socket: net.Socket | null = null;
  let stopping = false;
  let stdinSeq = 0;
  let pollTimer: NodeJS.Timeout | null = null;
  const pendingRemoteEvents: Array<{
    type?: string;
    stream?: "stdout" | "stderr";
    data?: string;
    code?: number | null;
    signal?: string | null;
    message?: string;
  }> = [];
  const token = createSandboxCallbackBridgeToken(18);
  const proxyDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-session-proxy-"));

  const writeRemoteEventToSocket = (event: (typeof pendingRemoteEvents)[number]) => {
    if (!socket) return false;
    socket.write(jsonLine(event));
    if (event.type === "exit") {
      stopping = true;
      socket.end();
    } else if (event.type === "error") {
      stopping = true;
      socket.destroy();
    }
    return true;
  };

  const deliverRemoteEvent = (event: (typeof pendingRemoteEvents)[number]) => {
    if (socket) {
      writeRemoteEventToSocket(event);
      return;
    }
    pendingRemoteEvents.push(event);
    if (event.type === "exit" || event.type === "error") {
      stopping = true;
    }
  };

  const flushPendingRemoteEvents = () => {
    if (!socket) return;
    while (pendingRemoteEvents.length > 0 && socket) {
      const event = pendingRemoteEvents.shift();
      if (event) writeRemoteEventToSocket(event);
    }
  };

  const liveSockets = new Set<net.Socket>();
  const server = net.createServer((nextSocket) => {
    liveSockets.add(nextSocket);
    nextSocket.setEncoding("utf8");
    nextSocket.on("error", () => undefined);
    let connectionBuffer = "";
    let authenticated = false;
    // Connections own the session (and receive buffered process output) only
    // after presenting the bridge token; idle unauthenticated peers are dropped.
    const authTimer = setTimeout(() => {
      if (!authenticated) nextSocket.destroy();
    }, PROCESS_SESSION_AUTH_TIMEOUT_MS);
    authTimer.unref?.();
    nextSocket.on("close", () => {
      clearTimeout(authTimer);
      liveSockets.delete(nextSocket);
    });
    nextSocket.on("data", (chunk) => {
      connectionBuffer += chunk;
      const split = splitJsonLines(connectionBuffer);
      connectionBuffer = split.rest;
      for (const line of split.lines) {
        if (!line.trim()) continue;
        let message: { token?: string; type?: string; data?: string };
        try {
          message = JSON.parse(line) as { token?: string; type?: string; data?: string };
        } catch {
          nextSocket.destroy();
          return;
        }
        if (message.token !== token) {
          nextSocket.destroy();
          return;
        }
        if (!authenticated) {
          if (socket) {
            nextSocket.destroy();
            return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          socket = nextSocket;
          flushPendingRemoteEvents();
        }
        void (async () => {
          if (message.type === "stdin" && typeof message.data === "string") {
            stdinSeq += 1;
            const name = `${String(stdinSeq).padStart(12, "0")}.json`;
            await client.writeTextFile(path.posix.join(stdinDir, name), jsonLine({ type: "stdin", data: message.data }));
          } else if (message.type === "stdinEnd") {
            stdinSeq += 1;
            const name = `${String(stdinSeq).padStart(12, "0")}.json`;
            await client.writeTextFile(path.posix.join(stdinDir, name), jsonLine({ type: "stdinEnd" }));
          }
        })().catch((error) => {
          nextSocket.write(jsonLine({ type: "error", message: error instanceof Error ? error.message : String(error) }));
          nextSocket.destroy();
        });
      }
    });
  });

  const poll = async () => {
    if (stopping) return;
    try {
      const events = await readRemoteJsonFiles({ client, dir: eventsDir });
      for (const event of events) {
        const parsed = JSON.parse(event.body) as {
          type?: string;
          stream?: "stdout" | "stderr";
          data?: string;
          code?: number | null;
          signal?: string | null;
          message?: string;
        };
        deliverRemoteEvent(parsed);
        if (parsed.type === "exit" || parsed.type === "error") return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await onLog("stderr", `[paperclip] ACP process session bridge poll failed: ${message}\n`);
      deliverRemoteEvent({ type: "error", message });
      return;
    } finally {
      if (!stopping) {
        pollTimer = setTimeout(() => void poll(), 100);
        pollTimer.unref?.();
      }
    }
  };

  const port = await waitForLocalServerListen(server);
  const agentCommand = await writeProcessSessionProxyScript(proxyDir, port, token);
  pollTimer = setTimeout(() => void poll(), 100);
  pollTimer.unref?.();

  return {
    agentCommand,
    stop: async () => {
      stopping = true;
      if (pollTimer) clearTimeout(pollTimer);
      for (const liveSocket of liveSockets) liveSocket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      await client.writeTextFile(
        path.posix.join(stdinDir, `${String(stdinSeq + 1).padStart(12, "0")}.json`),
        jsonLine({ type: "stdinEnd" }),
      ).catch(() => undefined);
      await client.remove(sessionDir).catch(() => undefined);
      await fs.rm(proxyDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function getProcessSessionProxySource(input: { port: number; token: string }): string {
  return `#!/usr/bin/env node
import net from "node:net";

const socket = net.createConnection({ host: "127.0.0.1", port: ${input.port} });
const token = ${JSON.stringify(input.token)};
let buffer = "";
let exiting = false;

function send(message) {
  socket.write(JSON.stringify({ token, ...message }) + "\\n");
}

socket.on("connect", () => send({ type: "hello" }));
process.stdin.on("data", (chunk) => send({ type: "stdin", data: Buffer.from(chunk).toString("base64") }));
process.stdin.on("end", () => send({ type: "stdinEnd" }));
process.stdin.resume();

socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  const parts = buffer.split(/\\n/);
  buffer = parts.pop() || "";
  for (const line of parts) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === "data") {
      const out = Buffer.from(message.data || "", "base64");
      (message.stream === "stderr" ? process.stderr : process.stdout).write(out);
    } else if (message.type === "error") {
      process.stderr.write(String(message.message || "Process session bridge failed.") + "\\n");
      exiting = true;
      process.exitCode = 1;
      socket.end();
    } else if (message.type === "exit") {
      exiting = true;
      process.exitCode = typeof message.code === "number" ? message.code : 1;
      socket.end();
    }
  }
});
socket.on("close", () => {
  if (!exiting) process.exit(1);
});
`;
}

function getProcessSessionRemoteSource(): string {
  return `import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const sessionDir = process.env.PAPERCLIP_PROCESS_SESSION_DIR;
const commandPayload = process.env.PAPERCLIP_PROCESS_SESSION_COMMAND_B64;
if (!sessionDir || !commandPayload) throw new Error("Missing process session bridge env.");

const stdinDir = path.posix.join(sessionDir, "stdin");
const eventsDir = path.posix.join(sessionDir, "events");
let seq = 0;
let stdinClosed = false;

const config = JSON.parse(Buffer.from(commandPayload, "base64").toString("utf8"));
await fs.mkdir(stdinDir, { recursive: true });
await fs.mkdir(eventsDir, { recursive: true });

let writeChain = Promise.resolve();

function writeEvent(event) {
  seq += 1;
  const file = path.posix.join(eventsDir, String(seq).padStart(12, "0") + ".json");
  const write = writeChain.then(async () => {
    await fs.writeFile(file + ".tmp", JSON.stringify(event) + "\\n", "utf8");
    await fs.rename(file + ".tmp", file);
  });
  writeChain = write.catch(() => undefined);
  return write;
}

const child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
  cwd: config.cwd || process.cwd(),
  env: { ...process.env, ...(config.env || {}) },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => void writeEvent({ type: "data", stream: "stdout", data: Buffer.from(chunk).toString("base64") }));
child.stderr.on("data", (chunk) => void writeEvent({ type: "data", stream: "stderr", data: Buffer.from(chunk).toString("base64") }));
child.on("error", (error) => void writeEvent({ type: "error", message: error.message }));
// "close" (not "exit") so stdout/stderr fully drain before the exit event;
// the write chain then guarantees the exit file lands after every data file.
child.on("close", (code, signal) => void writeEvent({ type: "exit", code, signal }));

async function pollStdin() {
  while (!stdinClosed) {
    const entries = (await fs.readdir(stdinDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    for (const name of entries) {
      const file = path.posix.join(stdinDir, name);
      const raw = await fs.readFile(file, "utf8").catch(() => null);
      await fs.rm(file, { force: true }).catch(() => undefined);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.type === "stdin" && typeof message.data === "string") {
        child.stdin.write(Buffer.from(message.data, "base64"));
      } else if (message.type === "stdinEnd") {
        stdinClosed = true;
        child.stdin.end();
        break;
      }
    }
    if (!stdinClosed) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

void pollStdin().catch((error) => void writeEvent({ type: "error", message: error instanceof Error ? error.message : String(error) }));
`;
}

export async function startAdapterExecutionTargetPaperclipBridge(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  runtimeRootDir: string | null | undefined;
  adapterKey: string;
  timeoutSec?: number | null;
  hostApiToken: string | null | undefined;
  hostApiUrl?: string | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  maxBodyBytes?: number | null;
}): Promise<AdapterExecutionTargetPaperclipBridgeHandle | null> {
  if (!adapterExecutionTargetUsesPaperclipBridge(input.target)) {
    return null;
  }
  if (!input.target || input.target.kind !== "remote") {
    return null;
  }

  const target = input.target;
  const onLog = input.onLog ?? (async () => {});
  const hostApiToken = input.hostApiToken?.trim() ?? "";
  if (hostApiToken.length === 0) {
    throw new Error("Sandbox bridge mode requires a host-side Paperclip API token.");
  }

  const runtimeRootDir =
    input.runtimeRootDir?.trim().length
      ? input.runtimeRootDir.trim()
      : path.posix.join(target.remoteCwd, ".paperclip-runtime", input.adapterKey);
  const bridgeRuntimeDir = path.posix.join(runtimeRootDir, "paperclip-bridge");
  const queueDir = path.posix.join(bridgeRuntimeDir, "queue");
  const assetRemoteDir = path.posix.join(bridgeRuntimeDir, "server");
  const bridgeToken = createSandboxCallbackBridgeToken();
  const maxBodyBytes =
    typeof input.maxBodyBytes === "number" && Number.isFinite(input.maxBodyBytes) && input.maxBodyBytes > 0
      ? Math.trunc(input.maxBodyBytes)
      : DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES;
  const hostApiUrl =
    input.hostApiUrl?.trim() ||
    process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    resolveDefaultPaperclipApiUrl();
  const shellCommand = adapterExecutionTargetShellCommand(target);
  const runner = adapterExecutionTargetCommandRunner(target);
  const bridgeTimeoutMs =
    typeof input.timeoutSec === "number" && Number.isFinite(input.timeoutSec) && input.timeoutSec > 0
      ? Math.trunc(input.timeoutSec * 1000)
      : adapterExecutionTargetTimeoutMs(target);

  await onLog(
    "stdout",
    `[paperclip] Starting sandbox callback bridge for ${input.adapterKey} in ${bridgeRuntimeDir}.\n`,
  );

  const bridgeAsset = await createSandboxCallbackBridgeAsset();
  let server: Awaited<ReturnType<typeof startSandboxCallbackBridgeServer>> | null = null;
  let worker: Awaited<ReturnType<typeof startSandboxCallbackBridgeWorker>> | null = null;
  try {
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({
      runner,
      remoteCwd: target.remoteCwd,
      timeoutMs: bridgeTimeoutMs,
      shellCommand,
    });
    // PAPERCLIP_BRIDGE_DEBUG opts into verbose stdout logs of every bridge
    // proxy request/response. The query string is logged verbatim, so callers
    // who pass auth tokens or other sensitive values as query parameters
    // should be aware those values appear in the host process's stdout when
    // this flag is enabled. Only intended for active debugging in trusted
    // environments.
    const bridgeDebugEnabled = isBridgeDebugEnabled(process.env);
    worker = await startSandboxCallbackBridgeWorker({
      client,
      queueDir,
      maxBodyBytes,
      handleRequest: async (request) => {
        const method = request.method.trim().toUpperCase() || "GET";
        if (bridgeDebugEnabled) {
          await onLog(
            "stdout",
            `[paperclip] Bridge proxy ${method} ${request.path}${request.query ? `?${request.query}` : ""}\n`,
          );
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value.trim().length === 0) continue;
          headers.set(key, value);
        }
        headers.set("authorization", `Bearer ${hostApiToken}`);
        headers.set("x-paperclip-run-id", input.runId);
        const response = await fetch(buildBridgeForwardUrl(hostApiUrl, request), {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" ? {} : { body: request.body }),
          signal: AbortSignal.timeout(30_000),
        });
        if (bridgeDebugEnabled) {
          await onLog(
            "stdout",
            `[paperclip] Bridge proxy response ${response.status} for ${method} ${request.path}${request.query ? `?${request.query}` : ""}\n`,
          );
        }
        return {
          status: response.status,
          headers: buildBridgeResponseHeaders(response),
          body: await readBridgeForwardResponseBody(response, maxBodyBytes),
        };
      },
    });
    server = await startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: target.remoteCwd,
      assetRemoteDir,
      queueDir,
      bridgeToken,
      bridgeAsset,
      timeoutMs: bridgeTimeoutMs,
      maxBodyBytes,
      shellCommand,
    });
  } catch (error) {
    await Promise.allSettled([
      server?.stop(),
      worker?.stop(),
      bridgeAsset.cleanup(),
    ]);
    throw error;
  }

  let runLogTail: SandboxRunLogTailFactory | null = null;
  if (target.transport === "sandbox" && target.streamRunLogs !== false) {
    runLogTail = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: target.remoteCwd,
      logsDir: sandboxCallbackBridgeDirectories(queueDir).logsDir,
      shellCommand,
    });
    await onLog("stdout", "[paperclip] Sandbox run log streaming enabled for this run.\n");
  }

  return {
    env: {
      PAPERCLIP_API_URL: server.baseUrl,
      PAPERCLIP_API_KEY: bridgeToken,
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
      PAPERCLIP_BRIDGE_QUEUE_DIR: queueDir,
    },
    runLogTail,
    stop: async () => {
      await Promise.allSettled([
        server?.stop(),
      ]);
      await Promise.allSettled([
        worker?.stop(),
        bridgeAsset.cleanup(),
      ]);
    },
  };
}
