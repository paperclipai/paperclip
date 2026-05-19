/**
 * Phase 4A-S4 (LET-417 / LET-370 B5 step 1): canary-fire harness.
 *
 * This harness drives the LET-366 live `E2BSandboxProvider` through one
 * acquire/start/exec/release cycle so the LET-370 follow-up can fire it
 * against `api.e2b.app` and capture audit evidence under controlled
 * conditions. It is not a server: nothing here owns long-running state.
 *
 * Modes:
 *  - `--mode=dry-run` (default): the harness wires the provider against an
 *    injected stub fetch. No outbound network egress is performed. Used by
 *    the unit tests + the CI smoke that ships with this PR.
 *  - `--mode=live`: the harness wires the provider against the real
 *    `globalThis.fetch`. Refuses to enter live mode unless ALL three gates
 *    pass: `SANDBOX_PROVIDER_ALLOW_LIVE=true`, Layer 1 config
 *    `sandbox.providers.e2b.enabled=true`, and the canonical secret ref
 *    `sandbox.providers.e2b.apiKeySecret` is configured. The follow-up
 *    LET-370 heartbeat is what actually flips `--mode=live`.
 *
 * The harness plants three secrets into the pre-egress redaction registry
 * before any provider call:
 *  - the resolved E2B API key (dummy in dry-run, real in live),
 *  - a per-run canary token (`CANARY-S4-<run-id>-<hex>`),
 *  - a per-run dummy secret (`DUMMY_SECRET_<run-id>_<hex>`).
 *
 * After the cycle completes the harness asserts that none of the three
 * registered values appear in any captured request URL, header, or body,
 * that the `[REDACTED]` placeholder appears on the exec request body, and
 * that the captured request set matches the canary call shape — exactly
 * one create (POST /sandboxes), one exec (POST /process.Process/Start),
 * one destroy (DELETE /sandboxes/{id}), and a `/sandboxes/{id}/connect`
 * count that is mode-specific. Post-LET-431 the live transport caches the
 * envd session from the create response and skips /connect on the
 * fresh-create path; the resume path (`resumeLease` on a provider
 * instance with an empty in-memory session map) still issues exactly
 * one /connect to refresh the envd token.
 *
 * Per LET-435 the shape validator is mode-aware:
 *   - fresh-create (the CLI / canary-fire default): connect MUST be 0; a
 *     captured /connect is a regression and fails with
 *     WRONG_REQUEST_SHAPE so the LET-370 re-fire can never silently
 *     resurrect the pre-LET-431 4-call shape.
 *   - resume: connect MUST be 1 (the persisted-lease recovery path); the
 *     in-process resume-style end-to-end test passes this mode
 *     explicitly. The CLI does not currently expose a resume entrypoint.
 *
 * See `validateRequestShape` for the full reasoning.
 *
 * The captured request log is serialised to
 * `dist/canary-evidence-<run-id>.json` next to this script so the LET-370
 * follow-up heartbeat can upload it as part of the canary proof document.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  E2BSandboxProvider,
  E2B_SANDBOX_PROVIDER_KEY,
  MANAGED_SANDBOX_LIVE_ENV,
  isManagedSandboxLiveAllowed,
  type ManagedSandboxProviderConfig,
} from "../src/services/sandbox/managed-provider-spikes.ts";
import { PreProviderRedactionRegistry } from "../src/services/sandbox/pre-provider-redaction.ts";
import type { E2BCapturedRequest } from "../src/services/sandbox/e2b-live-transport.ts";

export type CanaryFireMode = "dry-run" | "live";

/**
 * Distinct exit codes per failure mode so the LET-370 follow-up can branch
 * on the recorded value without parsing stdout. `0` only on a clean run
 * where every assertion passes and the evidence file is written.
 */
export const CANARY_FIRE_EXIT_CODES = {
  OK: 0,
  ARG_PARSE_ERROR: 2,
  GATE_FAILURE: 10,
  REGISTRY_TOO_SMALL: 11,
  TRANSPORT_ERROR: 12,
  APIKEY_LEAK: 20,
  CANARY_TOKEN_LEAK: 21,
  DUMMY_SECRET_LEAK: 22,
  MISSING_PLACEHOLDER: 23,
  WRONG_REQUEST_SHAPE: 30,
  UNEXPECTED_ERROR: 99,
} as const;

export type CanaryFireExitCode =
  (typeof CANARY_FIRE_EXIT_CODES)[keyof typeof CANARY_FIRE_EXIT_CODES];

export interface CanaryFireGateInputs {
  /** `SANDBOX_PROVIDER_ALLOW_LIVE === "true"`. */
  liveEnvAllowed: boolean;
  /** Layer 1 `sandbox.providers.e2b.enabled === true`. */
  layer1Enabled: boolean;
  /** The canonical secret ref `sandbox.providers.e2b.apiKeySecret` is
   *  configured. Presence-only — never resolves or prints the value. */
  secretRefPresent: boolean;
}

export interface CanaryFireRunInputs {
  mode: CanaryFireMode;
  runId: string;
  canaryToken: string;
  dummySecret: string;
}

/**
 * Per LET-435 the captured-request shape validator is mode-aware. The CLI
 * canary-fire path always uses `fresh-create` (the LET-431 SDK-aligned
 * shape; /connect must NOT be captured). The in-process resume-style
 * end-to-end test passes `resume` so its one captured /connect call is
 * required, not merely tolerated.
 */
export type CanaryRequestShapeMode = "fresh-create" | "resume";

export interface CanaryFireDependencies {
  /** Injected fetch implementation. Tests pass a stub. The CLI passes
   *  `globalThis.fetch` only in live mode; dry-run CLI runs use a
   *  null-recording stub so a stray invocation surfaces immediately. */
  fetchImpl?: typeof fetch;
  /** Resolved E2B API key value. Tests inject a dummy; the live CLI path
   *  resolves it via `secretService`. The value is registered into the
   *  redaction registry before the provider is constructed. */
  resolvedApiKey: string;
  /** Three-gate inputs evaluated by the harness for live mode. */
  gates: CanaryFireGateInputs;
  /** Output directory for the evidence JSON. */
  evidenceDir: string;
  /** Optional human-readable log sink. Defaults to process.stdout. */
  logger?: (message: string) => void;
  /** Expected captured-request shape. Defaults to `fresh-create` (the
   *  CLI canary-fire path; LET-431 regression guard). */
  requestShapeMode?: CanaryRequestShapeMode;
}

export interface CanaryFireResult {
  exitCode: CanaryFireExitCode;
  failure: string | null;
  mode: CanaryFireMode;
  runId: string;
  evidencePath: string | null;
  capturedRequests: E2BCapturedRequest[];
  registrySize: number;
}

const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * RFC 4122 UUID matcher (any version, lowercase). The harness enforces this
 * shape on explicit `--run-id` values so the run id can safely be used as a
 * basename component of the evidence file path without risk of directory
 * traversal (e.g. `../../tmp/x`) escaping the configured evidence directory.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidRunIdUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function generateCanaryToken(runId: string): string {
  return `CANARY-S4-${runId}-${randomBytes(8).toString("hex")}`;
}

export function generateDummySecret(runId: string): string {
  return `DUMMY_SECRET_${runId}_${randomBytes(12).toString("hex")}`;
}

export function parseHarnessArgs(
  argv: string[],
): { ok: true; inputs: CanaryFireRunInputs } | { ok: false; error: string } {
  let mode: CanaryFireMode = "dry-run";
  let runId: string | undefined;
  let canaryToken: string | undefined;
  let dummySecret: string | undefined;
  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      return { ok: false, error: `Unrecognised argument: ${raw}` };
    }
    const equalsIdx = raw.indexOf("=");
    if (equalsIdx === -1) {
      return { ok: false, error: `Argument requires =VALUE: ${raw}` };
    }
    const key = raw.slice(2, equalsIdx);
    const value = raw.slice(equalsIdx + 1);
    switch (key) {
      case "mode":
        if (value !== "dry-run" && value !== "live") {
          return { ok: false, error: `--mode must be dry-run or live (got: ${value})` };
        }
        mode = value;
        break;
      case "run-id":
        if (value.length === 0) return { ok: false, error: "--run-id must be non-empty" };
        if (!isValidRunIdUuid(value)) {
          return {
            ok: false,
            error:
              "--run-id must be a lowercase RFC 4122 UUID (e.g. 11111111-2222-4333-8444-555555555555); " +
              "rejected to prevent unsafe characters from escaping the evidence directory",
          };
        }
        runId = value;
        break;
      case "canary-token":
        if (value.length === 0) return { ok: false, error: "--canary-token must be non-empty" };
        canaryToken = value;
        break;
      case "dummy-secret":
        if (value.length === 0) return { ok: false, error: "--dummy-secret must be non-empty" };
        dummySecret = value;
        break;
      default:
        return { ok: false, error: `Unknown flag: --${key}` };
    }
  }
  const resolvedRunId = runId ?? randomUUID();
  return {
    ok: true,
    inputs: {
      mode,
      runId: resolvedRunId,
      canaryToken: canaryToken ?? generateCanaryToken(resolvedRunId),
      dummySecret: dummySecret ?? generateDummySecret(resolvedRunId),
    },
  };
}

export async function runCanaryFire(
  inputs: CanaryFireRunInputs,
  deps: CanaryFireDependencies,
): Promise<CanaryFireResult> {
  const log = deps.logger ?? ((line) => process.stdout.write(`${line}\n`));
  const captured: E2BCapturedRequest[] = [];

  if (inputs.mode === "live") {
    const missing: string[] = [];
    if (!deps.gates.liveEnvAllowed) missing.push(`${MANAGED_SANDBOX_LIVE_ENV}=true`);
    if (!deps.gates.layer1Enabled) missing.push("sandbox.providers.e2b.enabled=true");
    if (!deps.gates.secretRefPresent) missing.push("sandbox.providers.e2b.apiKeySecret");
    if (missing.length > 0) {
      const msg = `Refusing live mode — missing gates: ${missing.join(", ")}`;
      log(msg);
      return finalise({
        exitCode: CANARY_FIRE_EXIT_CODES.GATE_FAILURE,
        failure: msg,
        inputs,
        captured,
        registrySize: 0,
        evidenceDir: deps.evidenceDir,
      });
    }
  }

  const redactionRegistry = new PreProviderRedactionRegistry();
  redactionRegistry.register(deps.resolvedApiKey);
  redactionRegistry.register(inputs.canaryToken);
  redactionRegistry.register(inputs.dummySecret);

  if (redactionRegistry.size() < 3) {
    const msg = `Redaction registry too small (${redactionRegistry.size()} < 3); refusing to proceed.`;
    log(msg);
    return finalise({
      exitCode: CANARY_FIRE_EXIT_CODES.REGISTRY_TOO_SMALL,
      failure: msg,
      inputs,
      captured,
      registrySize: redactionRegistry.size(),
      evidenceDir: deps.evidenceDir,
    });
  }

  // The provider's own three-gate check requires SANDBOX_PROVIDER_ALLOW_LIVE.
  // The harness exposes a `--mode=live` superset gate but always sets the
  // env var locally so the provider's live transport spins up. In dry-run
  // the stubbed fetch keeps egress contained. The previous value is
  // restored before the function returns so the caller's env is untouched.
  const previousLiveEnv = process.env[MANAGED_SANDBOX_LIVE_ENV];
  process.env[MANAGED_SANDBOX_LIVE_ENV] = "true";

  try {
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => deps.resolvedApiKey,
      redactionRegistry,
      fetchImpl: deps.fetchImpl,
      onRequest: (request) => captured.push(request),
    });

    const config: ManagedSandboxProviderConfig = {
      provider: E2B_SANDBOX_PROVIDER_KEY,
      template: "base",
      reuseLease: false,
      timeoutMs: 30_000,
      env: {
        CANARY_FIRE_RUN_ID: inputs.runId,
        CANARY_TOKEN_ENV: inputs.canaryToken,
        DUMMY_SECRET_ENV: inputs.dummySecret,
      },
    };

    const acquireInput = {
      config,
      environmentId: `canary-fire-${inputs.runId}`,
      heartbeatRunId: `canary-fire-${inputs.runId}`,
      issueId: "LET-417",
    };

    let lease;
    try {
      lease = await provider.acquireLease(acquireInput);
    } catch (error) {
      return failTransport("acquireLease", error, inputs, captured, redactionRegistry.size(), deps.evidenceDir, log);
    }

    try {
      await provider.start({ lease });
    } catch (error) {
      return failTransport("start", error, inputs, captured, redactionRegistry.size(), deps.evidenceDir, log);
    }

    try {
      await provider.exec({
        config,
        providerLeaseId: lease.providerLeaseId,
        command: "/bin/echo",
        // Tokens are planted into command args and env values. The LET-366
        // live transport rejects non-empty stdin via a CONFIG_INVALID guard
        // in E2BLiveHttpTransport.executeCommand because the SendInput /
        // CloseStdin RPC pair is not wired in the pilot slice. Per LET-417
        // scope ruling (no edits to existing code paths), the stdin payload
        // surface is deferred to the LET-365 plan B-series follow-up that
        // wires those RPCs. The redaction-registry assertion below still
        // verifies the registered values never appear anywhere in the
        // captured outbound payload, which covers the "stdin payload"
        // surface vacuously here: nothing is transmitted.
        args: [
          `--canary=${inputs.canaryToken}`,
          `--dummy=${inputs.dummySecret}`,
        ],
        env: {
          CANARY_TOKEN_EXEC_ENV: inputs.canaryToken,
          DUMMY_SECRET_EXEC_ENV: inputs.dummySecret,
        },
      });
    } catch (error) {
      return failTransport("exec", error, inputs, captured, redactionRegistry.size(), deps.evidenceDir, log);
    }

    try {
      await provider.releaseLease({
        config,
        providerLeaseId: lease.providerLeaseId,
        status: "released",
      });
    } catch (error) {
      return failTransport("releaseLease", error, inputs, captured, redactionRegistry.size(), deps.evidenceDir, log);
    }

    const leakCheck = detectLeak(captured, {
      apiKey: deps.resolvedApiKey,
      canaryToken: inputs.canaryToken,
      dummySecret: inputs.dummySecret,
    });
    if (leakCheck) {
      log(leakCheck.message);
      return finalise({
        exitCode: leakCheck.exitCode,
        failure: leakCheck.message,
        inputs,
        captured,
        registrySize: redactionRegistry.size(),
        evidenceDir: deps.evidenceDir,
      });
    }

    const execRequest = captured.find(
      (request) => request.method === "POST" && safePathname(request.url) === "/process.Process/Start",
    );
    if (!execRequest) {
      const msg = "Wrong request shape: no captured POST /process.Process/Start request.";
      log(msg);
      return finalise({
        exitCode: CANARY_FIRE_EXIT_CODES.WRONG_REQUEST_SHAPE,
        failure: msg,
        inputs,
        captured,
        registrySize: redactionRegistry.size(),
        evidenceDir: deps.evidenceDir,
      });
    }
    if (!(execRequest.body ?? "").includes(REDACTED_PLACEHOLDER)) {
      const msg = "Exec request body is missing the [REDACTED] placeholder where planted tokens should have been redacted.";
      log(msg);
      return finalise({
        exitCode: CANARY_FIRE_EXIT_CODES.MISSING_PLACEHOLDER,
        failure: msg,
        inputs,
        captured,
        registrySize: redactionRegistry.size(),
        evidenceDir: deps.evidenceDir,
      });
    }

    const counts = countRequests(captured);
    const shapeMode: CanaryRequestShapeMode = deps.requestShapeMode ?? "fresh-create";
    const shapeIssues = validateRequestShape(counts, shapeMode);
    if (shapeIssues.length > 0) {
      const msg = `Wrong request shape: ${shapeIssues.join("; ")}`;
      log(msg);
      return finalise({
        exitCode: CANARY_FIRE_EXIT_CODES.WRONG_REQUEST_SHAPE,
        failure: msg,
        inputs,
        captured,
        registrySize: redactionRegistry.size(),
        evidenceDir: deps.evidenceDir,
      });
    }

    log(`Canary-fire ${inputs.mode} cycle complete (runId=${inputs.runId}); no leaks detected.`);
    return finalise({
      exitCode: CANARY_FIRE_EXIT_CODES.OK,
      failure: null,
      inputs,
      captured,
      registrySize: redactionRegistry.size(),
      evidenceDir: deps.evidenceDir,
    });
  } finally {
    if (previousLiveEnv === undefined) delete process.env[MANAGED_SANDBOX_LIVE_ENV];
    else process.env[MANAGED_SANDBOX_LIVE_ENV] = previousLiveEnv;
  }
}

function failTransport(
  phase: string,
  error: unknown,
  inputs: CanaryFireRunInputs,
  captured: E2BCapturedRequest[],
  registrySize: number,
  evidenceDir: string,
  log: (message: string) => void,
): Promise<CanaryFireResult> {
  const detail = error instanceof Error ? error.message : String(error);
  const msg = `Transport error in ${phase}: ${detail}`;
  log(msg);
  return finalise({
    exitCode: CANARY_FIRE_EXIT_CODES.TRANSPORT_ERROR,
    failure: msg,
    inputs,
    captured,
    registrySize,
    evidenceDir,
  });
}

interface LeakDetectInputs {
  apiKey: string;
  canaryToken: string;
  dummySecret: string;
}

function detectLeak(
  captured: E2BCapturedRequest[],
  tokens: LeakDetectInputs,
): { message: string; exitCode: CanaryFireExitCode } | null {
  const checks: Array<{ label: string; value: string; exitCode: CanaryFireExitCode }> = [
    { label: "apiKey", value: tokens.apiKey, exitCode: CANARY_FIRE_EXIT_CODES.APIKEY_LEAK },
    { label: "canaryToken", value: tokens.canaryToken, exitCode: CANARY_FIRE_EXIT_CODES.CANARY_TOKEN_LEAK },
    { label: "dummySecret", value: tokens.dummySecret, exitCode: CANARY_FIRE_EXIT_CODES.DUMMY_SECRET_LEAK },
  ];
  for (const request of captured) {
    const surfaces = collectStringSurfaces(request);
    for (const check of checks) {
      if (check.value.length === 0) continue;
      for (const surface of surfaces) {
        if (surface.value.includes(check.value)) {
          return {
            exitCode: check.exitCode,
            message: `Leak detected: ${check.label} value appears in ${request.method} ${request.url} (${surface.location}).`,
          };
        }
      }
    }
  }
  return null;
}

function collectStringSurfaces(request: E2BCapturedRequest): Array<{ location: string; value: string }> {
  const out: Array<{ location: string; value: string }> = [
    { location: "url", value: request.url },
  ];
  for (const [name, value] of Object.entries(request.headers)) {
    out.push({ location: `header.${name}`, value });
  }
  if (request.body !== null) out.push({ location: "body", value: request.body });
  return out;
}

export interface RequestCounts {
  createSandbox: number;
  connectSandbox: number;
  processStart: number;
  destroySandbox: number;
  total: number;
}

/**
 * Validate the per-endpoint request counts captured during a canary cycle.
 * Returns a list of human-readable issues (empty when the shape is acceptable).
 *
 * Post-LET-431 the live transport skips `POST /sandboxes/{id}/connect` on the
 * fresh-create path (the create response carries `envdAccessToken` + `domain`,
 * so `ensureSession` returns the cached session and `Sandbox.connect(id)` is
 * never issued). The resume path — `resumeLease` on a fresh provider instance
 * that has an empty in-memory session map — still issues exactly one
 * `/connect` call to refresh the envd token.
 *
 * Per LET-435 the validator is mode-aware. The CLI canary-fire path always
 * passes `fresh-create`; the in-process resume-style end-to-end test passes
 * `resume`.
 *
 * The validator therefore requires:
 *   - fresh-create cycle: create=1, connect=0, exec=1, destroy=1 (total 3)
 *     A captured /connect here is a LET-431 regression — the pre-LET-431
 *     transport always posted /connect on fresh-create; the post-LET-431
 *     transport must not. The validator returns a hard-error issue that
 *     names the regression so the harness exits WRONG_REQUEST_SHAPE.
 *   - resume cycle:       create=1, connect=1, exec=1, destroy=1 (total 4)
 *     A captured /connect is required, not optional. 0 connects on a
 *     resume cycle is a different regression — the persisted-lease
 *     recovery path is supposed to re-issue /connect to refresh the envd
 *     token. The validator surfaces that case too.
 *
 * Strict counts on create / exec / destroy guarantee the canary actually
 * fires: 0 captured exec calls => harness exits with WRONG_REQUEST_SHAPE,
 * which is the regression signal we still want to detect. The total
 * assertion is derived from the per-endpoint sums so stray unknown
 * endpoints (e.g. drift in the dry-run stub) surface too.
 */
export function validateRequestShape(
  counts: RequestCounts,
  mode: CanaryRequestShapeMode = "fresh-create",
): string[] {
  const shapeIssues: string[] = [];
  if (counts.createSandbox !== 1) shapeIssues.push(`POST /sandboxes count=${counts.createSandbox} (expected 1)`);
  const expectedConnect = mode === "fresh-create" ? 0 : 1;
  if (counts.connectSandbox !== expectedConnect) {
    const suffix =
      mode === "fresh-create"
        ? " — fresh-create must skip /connect (LET-431 regression guard)"
        : " — resume cycle must refresh the envd session via /connect";
    shapeIssues.push(
      `POST /sandboxes/{id}/connect count=${counts.connectSandbox} (expected ${expectedConnect} for ${mode})${suffix}`,
    );
  }
  if (counts.processStart !== 1) shapeIssues.push(`POST /process.Process/Start count=${counts.processStart} (expected 1)`);
  if (counts.destroySandbox !== 1) shapeIssues.push(`DELETE /sandboxes/{id} count=${counts.destroySandbox} (expected 1)`);
  const expectedTotal =
    counts.createSandbox + counts.connectSandbox + counts.processStart + counts.destroySandbox;
  if (counts.total !== expectedTotal) {
    shapeIssues.push(
      `total captured requests=${counts.total} (expected ${expectedTotal}; ${counts.total - expectedTotal} unrecognised endpoint(s))`,
    );
  }
  return shapeIssues;
}

export function countRequests(captured: E2BCapturedRequest[]): RequestCounts {
  const counts: RequestCounts = {
    createSandbox: 0,
    connectSandbox: 0,
    processStart: 0,
    destroySandbox: 0,
    total: captured.length,
  };
  for (const request of captured) {
    const pathname = safePathname(request.url);
    if (request.method === "POST" && pathname === "/sandboxes") counts.createSandbox += 1;
    else if (request.method === "POST" && /^\/sandboxes\/[^/]+\/connect$/.test(pathname)) counts.connectSandbox += 1;
    else if (request.method === "POST" && pathname === "/process.Process/Start") counts.processStart += 1;
    else if (request.method === "DELETE" && /^\/sandboxes\/[^/]+$/.test(pathname)) counts.destroySandbox += 1;
  }
  return counts;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

interface FinaliseInputs {
  exitCode: CanaryFireExitCode;
  failure: string | null;
  inputs: CanaryFireRunInputs;
  captured: E2BCapturedRequest[];
  registrySize: number;
  evidenceDir: string;
}

async function finalise(input: FinaliseInputs): Promise<CanaryFireResult> {
  const evidence = {
    schema: "phase-4a-s4-canary-fire-let-370/v1",
    runId: input.inputs.runId,
    mode: input.inputs.mode,
    exitCode: input.exitCode,
    failure: input.failure,
    registrySize: input.registrySize,
    capturedAt: new Date().toISOString(),
    requests: input.captured,
  };
  await mkdir(input.evidenceDir, { recursive: true });
  const evidenceDirResolved = path.resolve(input.evidenceDir);
  const evidencePath = path.join(
    evidenceDirResolved,
    `canary-evidence-${input.inputs.runId}.json`,
  );
  const evidencePathResolved = path.resolve(evidencePath);
  // Defence-in-depth: parseHarnessArgs already rejects non-UUID --run-id, but
  // a programmatic caller could still pass a traversal-shaped runId.
  if (
    evidencePathResolved !== evidencePath ||
    !evidencePathResolved.startsWith(evidenceDirResolved + path.sep)
  ) {
    throw new Error(
      `runId resolves outside evidenceDir (runId=${input.inputs.runId}); refusing to write`,
    );
  }
  await writeFile(evidencePathResolved, JSON.stringify(evidence, null, 2));
  return {
    exitCode: input.exitCode,
    failure: input.failure,
    mode: input.inputs.mode,
    runId: input.inputs.runId,
    evidencePath,
    capturedRequests: input.captured,
    registrySize: input.registrySize,
  };
}

interface DryRunStubResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function jsonStubResponse(body: unknown, status = 200): DryRunStubResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

function emptyStubResponse(status = 204): DryRunStubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function encodeConnectFrame(payload: Uint8Array, endOfStream = false): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = endOfStream ? 0x02 : 0x00;
  const len = payload.length;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payload, 5);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function connectStreamStubResponse(): DryRunStubResponse {
  const encoder = new TextEncoder();
  const startFrame = encodeConnectFrame(
    encoder.encode(JSON.stringify({ event: { start: { pid: 1 } } })),
  );
  const dataFrame = encodeConnectFrame(
    encoder.encode(JSON.stringify({
      event: { data: { stdout: Buffer.from("canary-ok\n", "utf8").toString("base64") } },
    })),
  );
  const endFrame = encodeConnectFrame(
    encoder.encode(JSON.stringify({ event: { end: { exitCode: 0 } } })),
  );
  const trailerFrame = encodeConnectFrame(encoder.encode("{}"), true);
  const bytes = concatBytes([startFrame, dataFrame, endFrame, trailerFrame]);
  return {
    ok: true,
    status: 200,
    text: async () => Buffer.from(bytes).toString("utf8"),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

/**
 * Built-in dry-run stub fetch used by the CLI when no stub is injected.
 * Returns canned responses for the four canary endpoints that mirror the
 * shapes the LET-366 live transport expects. Throws on any unexpected URL
 * so a transport-shape regression surfaces immediately. Never reaches the
 * real network.
 */
export function createDryRunStubFetch(sandboxId = "e2b-sandbox-canary-dry-run"): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    if (method === "POST" && parsed.pathname === "/sandboxes") {
      return jsonStubResponse({
        sandboxID: sandboxId,
        clientID: "canary-dry-run-client",
        envdAccessToken: "envd-canary-dry-run-token",
        envdVersion: "v0.1.99",
        domain: "e2b.app",
        state: "created",
        metadata: {},
      }) as unknown as Response;
    }
    if (method === "POST" && /^\/sandboxes\/[^/]+\/connect$/.test(parsed.pathname)) {
      return jsonStubResponse({
        sandboxID: sandboxId,
        clientID: "canary-dry-run-client",
        envdAccessToken: "envd-canary-dry-run-token",
        envdVersion: "v0.1.99",
        domain: "e2b.app",
        state: "running",
        metadata: {},
      }) as unknown as Response;
    }
    if (method === "POST" && parsed.pathname === "/process.Process/Start") {
      return connectStreamStubResponse() as unknown as Response;
    }
    if (method === "DELETE" && /^\/sandboxes\/[^/]+$/.test(parsed.pathname)) {
      return emptyStubResponse(204) as unknown as Response;
    }
    throw new Error(
      `canary-fire-let-370 dry-run stub: unexpected ${method} ${parsed.pathname}; refusing to dispatch to the real network.`,
    );
  }) as unknown as typeof fetch;
}

const SCRIPT_FILE_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE_PATH);
const DEFAULT_EVIDENCE_DIR = path.resolve(SCRIPT_DIR, "..", "dist");

async function bootstrapDepsForCli(inputs: CanaryFireRunInputs): Promise<CanaryFireDependencies> {
  // Load Paperclip config + open DB only in `live` mode, where the
  // three-gate presence check + secret resolution are required. In
  // `dry-run` mode the harness keeps the bootstrap minimal so the CLI
  // can run in environments without a configured database (e.g. CI smoke).
  if (inputs.mode === "live") {
    const { loadConfig } = await import("../src/config.ts");
    const { createDb } = await import("@paperclipai/db");
    const { secretService } = await import("../src/services/secrets.ts");
    const config = loadConfig();
    const e2b = config.sandbox.providers.e2b;
    const secretRef = e2b.apiKeySecret;
    const gates: CanaryFireGateInputs = {
      liveEnvAllowed: isManagedSandboxLiveAllowed(),
      layer1Enabled: e2b.enabled === true,
      secretRefPresent: secretRef !== null && secretRef !== undefined,
    };
    if (!gates.liveEnvAllowed || !gates.layer1Enabled || !gates.secretRefPresent || !secretRef) {
      return {
        fetchImpl: globalThis.fetch.bind(globalThis),
        resolvedApiKey: "",
        gates,
        evidenceDir: DEFAULT_EVIDENCE_DIR,
      };
    }
    const databaseUrl = config.databaseUrl;
    if (!databaseUrl) {
      throw new Error("canary-fire-let-370 live mode requires DATABASE_URL/config.databaseUrl.");
    }
    const db = createDb(databaseUrl);
    const secrets = secretService(db);
    const resolvedApiKey = await secrets.resolveSecretValue(
      secretRef.companyId,
      secretRef.secretId,
      secretRef.version ?? "latest",
      {
        consumerType: "system",
        consumerId: "sandbox.providers.e2b",
        configPath: "sandbox.providers.e2b.apiKeySecret",
        actorType: "system",
      },
    );
    return {
      fetchImpl: globalThis.fetch.bind(globalThis),
      resolvedApiKey,
      gates,
      evidenceDir: DEFAULT_EVIDENCE_DIR,
    };
  }
  // Dry-run CLI invocation: wire the built-in stub fetch so the harness
  // completes the full acquire/start/exec/release cycle and writes
  // evidence with exitCode 0. The stub returns canned shapes for the
  // four canary endpoints and throws on any unexpected URL, so a
  // transport-shape regression still surfaces immediately.
  return {
    fetchImpl: createDryRunStubFetch(),
    resolvedApiKey: "DUMMY_E2B_API_KEY_FOR_CANARY_DRY_RUN",
    gates: { liveEnvAllowed: false, layer1Enabled: false, secretRefPresent: false },
    evidenceDir: DEFAULT_EVIDENCE_DIR,
  };
}

async function main(): Promise<void> {
  const parsed = parseHarnessArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`canary-fire-let-370: ${parsed.error}\n`);
    process.exit(CANARY_FIRE_EXIT_CODES.ARG_PARSE_ERROR);
  }
  try {
    const deps = await bootstrapDepsForCli(parsed.inputs);
    const result = await runCanaryFire(parsed.inputs, deps);
    if (result.evidencePath) {
      process.stdout.write(`canary-fire-let-370: evidence at ${result.evidencePath}\n`);
    }
    process.exit(result.exitCode);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`canary-fire-let-370: unexpected error: ${detail}\n`);
    process.exit(CANARY_FIRE_EXIT_CODES.UNEXPECTED_ERROR);
  }
}

const invokedDirectly =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(SCRIPT_FILE_PATH);

if (invokedDirectly) {
  await main();
}
