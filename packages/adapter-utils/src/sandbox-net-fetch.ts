import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

import type { SandboxCallbackBridgeRequest } from "./sandbox-callback-bridge.js";
import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";

/**
 * Standard net-fetch door for sandboxed lanes (TSMC-20877).
 *
 * Sandbox providers intentionally deny direct outbound traffic, so a lane's
 * `curl`/DNS fails even when the host resolves fine. Instead of hand-rolled
 * escalations, a sandboxed run POSTs a small JSON manifest to the run-scoped
 * callback bridge (`$PAPERCLIP_NET_FETCH_URL`); the HOST executes a bounded
 * GET on the lane's behalf and returns status + body. Underneath, the bridge
 * is the workspace request-file / host response-file queue that already
 * carries issue comments and dispositions out of egress-less sandboxes.
 *
 * Security properties, all enforced host-side:
 * - GET only; http/https only; URLs must not carry credentials.
 * - Deny-default domain allowlist (defaults below + an operator config file).
 * - The destination must resolve to a PUBLIC unicast address; the socket is
 *   pinned to that resolved address (no DNS rebinding, no loopback/RFC1918).
 * - Response size cap (2 MiB default; a request may lower it, never raise it).
 * - No credential pass-through: lane-supplied headers are never forwarded and
 *   the bridge/API tokens never leave the host.
 * - Redirects are returned, not followed (a redirect target gets re-checked
 *   against the allowlist only if the lane requests it explicitly).
 * - Every request — allowed or denied — is logged to a company-scoped JSONL.
 */

export const SANDBOX_NET_FETCH_BRIDGE_PATH = "/paperclip/net-fetch";
export const DEFAULT_SANDBOX_NET_FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Below the bridge's in-sandbox response wait (30s) so the door reports its
// own timeout instead of the bridge timing the whole exchange out first.
export const DEFAULT_SANDBOX_NET_FETCH_TIMEOUT_MS = 20_000;
export const SANDBOX_NET_FETCH_ALLOWLIST_FILE_ENV = "PAPERCLIP_NET_FETCH_ALLOWLIST_FILE";
export const SANDBOX_NET_FETCH_ALLOWLIST_FILE_NAME = "net-fetch-allowlist.json";

// Deny-default starting set: the job-board / social APIs whose polls keep
// stranding sandboxed lanes. Additions belong in the operator config file —
// not in code — so the list can grow without a platform deploy.
export const DEFAULT_SANDBOX_NET_FETCH_DOMAIN_ALLOWLIST: readonly string[] = [
  "api.github.com",
  "boards-api.greenhouse.io",
  "api.ashbyhq.com",
  "api.lever.co",
  "amazon.jobs",
  "public.api.bsky.app",
  "bsky.social",
];

// JSON.stringify escapes worst-case content (control chars) at six output
// bytes per raw body byte; the slack covers url/headers/envelope keys. The
// bridge worker's response-size backstop must admit this envelope for the
// configured raw-body cap to be reachable.
const ENVELOPE_INFLATION_FACTOR = 6;
const ENVELOPE_SLACK_BYTES = 16 * 1024;

const COMPANY_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export interface SandboxNetFetchRequest {
  url: string;
  method: "GET";
  maxBytes: number;
}

export interface SandboxNetFetchResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: number;
}

/** Allowlist denial — surfaces as 403 through the bridge (vs 400 for a malformed manifest). */
export class SandboxNetFetchDeniedError extends Error {}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** Exact hostname or dot-boundary subdomain match ("amazon.jobs" covers "www.amazon.jobs", never "evilamazon.jobs"). */
export function isSandboxNetFetchHostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  return allowlist.some((entry) => {
    const domain = normalizeHostname(entry);
    return domain.length > 0 && (normalized === domain || normalized.endsWith(`.${domain}`));
  });
}

export function parseSandboxNetFetchRequest(
  body: string,
  options: { allowlist: readonly string[]; maxResponseBytes?: number | null },
): SandboxNetFetchRequest {
  const capBytes = normalizePositiveInt(options.maxResponseBytes, DEFAULT_SANDBOX_NET_FETCH_MAX_RESPONSE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("net-fetch requires a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("net-fetch requires an object with a URL.");
  }
  const { url, method = "GET", maxBytes } = parsed as Record<string, unknown>;
  if (typeof url !== "string" || url.trim().length === 0) throw new Error("net-fetch requires a non-empty URL.");
  if (method !== "GET") throw new Error("net-fetch only permits GET requests.");
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("net-fetch URL is not a valid absolute URL.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("net-fetch only permits http and https URLs.");
  }
  if (target.username || target.password) throw new Error("net-fetch URLs cannot include credentials.");
  let requestedMaxBytes = capBytes;
  if (maxBytes !== undefined) {
    if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error("net-fetch maxBytes must be a positive number.");
    }
    // A lane may lower the cap for itself; it can never raise the door's cap.
    requestedMaxBytes = Math.min(capBytes, Math.trunc(maxBytes));
  }
  if (!isSandboxNetFetchHostAllowed(target.hostname, options.allowlist)) {
    throw new SandboxNetFetchDeniedError(
      `net-fetch destination "${normalizeHostname(target.hostname)}" is not on the domain allowlist. ` +
        `Additions go in the operator net-fetch allowlist config (${SANDBOX_NET_FETCH_ALLOWLIST_FILE_NAME}).`,
    );
  }
  return { url: target.toString(), method: "GET", maxBytes: requestedMaxBytes };
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first !== 0 && first !== 10 && first !== 127 && first < 224 &&
    !(first === 100 && second >= 64 && second <= 127) &&
    !(first === 169 && second === 254) &&
    !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && second === 168) &&
    !(first === 198 && (second === 18 || second === 19));
}

/** Never use the host door as a path to loopback, private, or link-local services. */
export function isPublicSandboxNetFetchAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  // IPv6 link-local is fe80::/10, not just the fe80::/16 prefix. The
  // remaining fe00::/8 space is reserved, so reject the full range rather
  // than leaving a future parsing edge case at fe90::/10 open to the door.
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")) {
    return false;
  }
  const mappedV4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mappedV4 ? isPublicIpv4(mappedV4[1]!) : true;
}

function normalizePositiveInt(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

export interface SandboxNetFetchExecuteOptions {
  maxResponseBytes?: number | null;
  timeoutMs?: number | null;
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /** Test seam. Production leaves the public-unicast check in place. */
  allowAddress?: (address: string) => boolean;
}

export async function fetchSandboxNet(
  input: SandboxNetFetchRequest,
  options: SandboxNetFetchExecuteOptions = {},
): Promise<SandboxNetFetchResponse> {
  const target = new URL(input.url);
  const hostname = normalizeHostname(target.hostname);
  const resolve = options.resolve ?? (async (name: string) => await lookup(name, { all: true, verbatim: true }));
  const allowAddress = options.allowAddress ?? isPublicSandboxNetFetchAddress;
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await resolve(hostname);
  const selected = addresses.find((entry) => allowAddress(entry.address));
  if (!selected) throw new Error("net-fetch destination did not resolve to a public address.");

  const maxResponseBytes = normalizePositiveInt(
    input.maxBytes ?? options.maxResponseBytes,
    DEFAULT_SANDBOX_NET_FETCH_MAX_RESPONSE_BYTES,
  );
  const timeoutMs = normalizePositiveInt(options.timeoutMs, DEFAULT_SANDBOX_NET_FETCH_TIMEOUT_MS);
  const client = target.protocol === "https:" ? https : http;
  return await new Promise<SandboxNetFetchResponse>((resolvePromise, reject) => {
    let settled = false;
    const request = client.request(target, {
      method: "GET",
      // The ONLY outbound headers. Lane-supplied headers are intentionally
      // never forwarded: the door cannot carry credentials to an external
      // service, so a compromised sandbox cannot exfiltrate its run token.
      headers: { accept: "*/*", "user-agent": "Paperclip-sandbox-net-fetch/1" },
      // Pin the socket to the vetted address. Node may call the lookup shim in
      // either contract: `{all: true}` expects an address ARRAY, the classic
      // form expects `(err, address, family)`.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions && (lookupOptions as { all?: boolean }).all) {
          (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(
            null,
            [{ address: selected.address, family: selected.family }],
          );
          return;
        }
        callback(null, selected.address, selected.family);
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxResponseBytes) {
          // Settle BEFORE destroying: a fully-buffered response fires `end`
          // synchronously after this handler, which would otherwise win the
          // race and resolve an empty-body "success".
          fail(new Error(`net-fetch response body exceeded ${maxResponseBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const headers: Record<string, string> = {};
        for (const key of ["content-type", "content-length", "etag", "last-modified", "location"]) {
          const value = response.headers[key];
          if (typeof value === "string") headers[key] = value;
        }
        resolvePromise({
          url: target.toString(),
          status: response.statusCode ?? 502,
          headers,
          body: Buffer.concat(chunks, totalBytes).toString("utf8"),
          bytes: totalBytes,
        });
      });
    });
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      request.destroy();
    };
    request.setTimeout(timeoutMs, () => fail(new Error(`net-fetch timed out after ${timeoutMs}ms.`)));
    // `on`, not `once`: destroy() can emit a follow-up error, which must not
    // become an unhandled 'error' event after the promise settled.
    request.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    request.end();
  });
}

export interface SandboxNetFetchAllowlistConfig {
  allowlist: string[];
  configFile: string;
  warnings: string[];
}

function readStringArray(value: unknown, label: string, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`net-fetch allowlist config: "${label}" must be an array of domain strings; ignoring it.`);
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      warnings.push(`net-fetch allowlist config: ignoring non-string entry under "${label}".`);
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

export function defaultSandboxNetFetchAllowlistFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SANDBOX_NET_FETCH_ALLOWLIST_FILE_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(resolvePaperclipInstanceRootForAdapter({ env }), SANDBOX_NET_FETCH_ALLOWLIST_FILE_NAME);
}

/**
 * Deny-default allowlist resolution: built-in defaults, plus the operator
 * config file's global `allowlist`, plus its per-company `companies[<id>]`
 * additions. A missing file means defaults only. A malformed file NEVER
 * widens access — the door falls back to the defaults and reports warnings.
 *
 * Config shape:
 * `{ "allowlist": ["extra.example"], "companies": { "<companyId>": ["per-co.example"] } }`
 */
export async function loadSandboxNetFetchAllowlist(input: {
  configFile?: string | null;
  companyId?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<SandboxNetFetchAllowlistConfig> {
  const configFile = input.configFile?.trim()
    ? path.resolve(input.configFile.trim())
    : defaultSandboxNetFetchAllowlistFile(input.env ?? process.env);
  const warnings: string[] = [];
  const allowlist = new Set(DEFAULT_SANDBOX_NET_FETCH_DOMAIN_ALLOWLIST);

  let raw: string | null = null;
  try {
    raw = await fs.readFile(configFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      warnings.push(`net-fetch allowlist config ${configFile} is unreadable (${code ?? String(error)}); using built-in defaults.`);
    }
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("config root must be an object");
      }
      const record = parsed as Record<string, unknown>;
      for (const entry of readStringArray(record.allowlist, "allowlist", warnings)) allowlist.add(entry);
      const companies = record.companies;
      if (companies !== undefined) {
        if (!companies || typeof companies !== "object" || Array.isArray(companies)) {
          warnings.push('net-fetch allowlist config: "companies" must be an object of companyId -> domains; ignoring it.');
        } else if (input.companyId?.trim()) {
          const companyEntries = (companies as Record<string, unknown>)[input.companyId.trim()];
          for (const entry of readStringArray(companyEntries, `companies.${input.companyId.trim()}`, warnings)) {
            allowlist.add(entry);
          }
        }
      }
    } catch (error) {
      warnings.push(
        `net-fetch allowlist config ${configFile} is malformed (${error instanceof Error ? error.message : String(error)}); using built-in defaults.`,
      );
    }
  }
  return { allowlist: [...allowlist], configFile, warnings };
}

export interface SandboxNetFetchLogEntry {
  ts: string;
  runId: string | null;
  companyId: string | null;
  url: string;
  method: string;
  outcome: "ok" | "rejected" | "denied" | "error";
  status: number | null;
  bytes: number | null;
  durationMs: number;
  error?: string;
}

export function defaultSandboxNetFetchLogFile(companyId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const segment = companyId?.trim() && COMPANY_SEGMENT_RE.test(companyId.trim()) ? companyId.trim() : "unscoped";
  return path.join(resolvePaperclipInstanceRootForAdapter({ env }), "companies", segment, "logs", "net-fetch.jsonl");
}

export async function appendSandboxNetFetchLog(logFile: string, entry: SandboxNetFetchLogEntry): Promise<void> {
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
}

export interface SandboxNetFetchBridgeHandlerOptions {
  allowlist: readonly string[];
  companyId?: string | null;
  runId?: string | null;
  /** Company-scoped JSONL log destination. Defaults from companyId; pass to override (tests). */
  logFile?: string | null;
  maxResponseBytes?: number | null;
  timeoutMs?: number | null;
  resolve?: SandboxNetFetchExecuteOptions["resolve"];
  allowAddress?: SandboxNetFetchExecuteOptions["allowAddress"];
  onLogError?: (message: string) => void;
}

export interface SandboxNetFetchBridgeHandler {
  path: string;
  matches(request: Pick<SandboxCallbackBridgeRequest, "method" | "path">): boolean;
  handle(request: SandboxCallbackBridgeRequest): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  /** Bridge-worker response cap needed for the serialized envelope of a max-size body. */
  envelopeMaxBytes: number;
  logFile: string;
}

/**
 * The one net-fetch door implementation, shared by the production bridge
 * wiring in `execution-target.ts` and the channel integration tests, so the
 * tested surface IS the deployed surface.
 */
export function createSandboxNetFetchBridgeHandler(options: SandboxNetFetchBridgeHandlerOptions): SandboxNetFetchBridgeHandler {
  const maxResponseBytes = normalizePositiveInt(options.maxResponseBytes, DEFAULT_SANDBOX_NET_FETCH_MAX_RESPONSE_BYTES);
  const logFile = options.logFile?.trim() || defaultSandboxNetFetchLogFile(options.companyId ?? null);
  const companyId = options.companyId?.trim() || null;
  const runId = options.runId?.trim() || null;

  const log = async (entry: Omit<SandboxNetFetchLogEntry, "ts" | "runId" | "companyId">) => {
    try {
      await appendSandboxNetFetchLog(logFile, {
        ts: new Date().toISOString(),
        runId,
        companyId,
        ...entry,
      });
    } catch (error) {
      // The log is an audit trail, not a gate: a full disk must not turn the
      // door into a new outage class. Loud in the run log, never fatal.
      options.onLogError?.(
        `net-fetch audit log append failed for ${logFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const jsonResponse = (status: number, body: unknown) => ({
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    path: SANDBOX_NET_FETCH_BRIDGE_PATH,
    envelopeMaxBytes: maxResponseBytes * ENVELOPE_INFLATION_FACTOR + ENVELOPE_SLACK_BYTES,
    logFile,
    matches: (request) =>
      request.method.trim().toUpperCase() === "POST" && request.path === SANDBOX_NET_FETCH_BRIDGE_PATH,
    handle: async (request) => {
      const startedAt = Date.now();
      let parsed: SandboxNetFetchRequest;
      try {
        parsed = parseSandboxNetFetchRequest(request.body, {
          allowlist: options.allowlist,
          maxResponseBytes,
        });
      } catch (error) {
        const denied = error instanceof SandboxNetFetchDeniedError;
        const message = error instanceof Error ? error.message : String(error);
        let requestedUrl = "";
        try {
          const body = JSON.parse(request.body) as Record<string, unknown>;
          if (typeof body.url === "string") requestedUrl = body.url;
        } catch {
          // unparseable body — log with an empty url
        }
        await log({
          url: requestedUrl,
          method: "GET",
          outcome: denied ? "denied" : "rejected",
          status: null,
          bytes: null,
          durationMs: Date.now() - startedAt,
          error: message,
        });
        return jsonResponse(denied ? 403 : 400, { error: message });
      }

      try {
        const result = await fetchSandboxNet(parsed, {
          maxResponseBytes,
          timeoutMs: options.timeoutMs,
          resolve: options.resolve,
          allowAddress: options.allowAddress,
        });
        await log({
          url: parsed.url,
          method: parsed.method,
          outcome: "ok",
          status: result.status,
          bytes: result.bytes,
          durationMs: Date.now() - startedAt,
        });
        return jsonResponse(200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await log({
          url: parsed.url,
          method: parsed.method,
          outcome: "error",
          status: null,
          bytes: null,
          durationMs: Date.now() - startedAt,
          error: message,
        });
        return jsonResponse(502, { error: message });
      }
    },
  };
}
