/**
 * API deliverable runner.
 *
 * Executes an HTTP contract test described by a single JSON spec file. The spec declares:
 *   - method: GET | POST | PUT | PATCH | DELETE
 *   - url: the full HTTPS URL to hit (must match the issue's verification_target)
 *   - expectedStatus: number | number[] (allowable HTTP status codes)
 *   - expectedResponseSchema?: a valid JSON Schema (ajv-compatible) for the response body
 *   - headers?: request headers
 *   - body?: request body (JSON)
 *   - notBody?: string[] — values that must NOT appear in the response body (negative checks)
 *
 * Unlike the Playwright runner this runs entirely inside the Paperclip server container — no
 * SSH to a remote VPS, no browser, no build manifest. It's a straight HTTP probe + schema check.
 *
 * The spec lives under skills/acceptance-api-specs/tests/<ISSUE_IDENTIFIER>.api.spec.json in the
 * Paperclip repo, read from the container's /app/skills/... at runtime.
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import type { ErrorObject } from "ajv";
// ajv v8 ESM/CJS interop is tricky under Node ESM — use createRequire so we always get the
// runtime class regardless of how tsc resolves the module shape.
import { createRequire } from "node:module";
const requireCjs = createRequire(import.meta.url);
const AjvClass: new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };
} = requireCjs("ajv");

export interface RunApiSpecInput {
  issueId: string;
  specPath: string; // e.g. skills/acceptance-api-specs/tests/DLD-1234.api.spec.json
  /** Absolute path inside the server container where skills/ lives. Defaults to /app */
  skillsRoot?: string;
  /** Override fetch for tests */
  fetchImpl?: typeof fetch;
  /** Override fs.readFile for tests */
  readFileImpl?: typeof readFile;
  /** Timeout for the HTTP request */
  requestTimeoutMs?: number;
}

export type RunApiSpecResult =
  | {
      status: "passed";
      durationMs: number;
      httpStatus: number;
    }
  | {
      status: "failed";
      durationMs: number;
      failureSummary: string;
      httpStatus?: number;
      body?: unknown;
    }
  | {
      status: "unavailable";
      unavailableReason: string;
    };

interface ApiSpec {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  expectedStatus: number | number[];
  expectedResponseSchema?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  notBody?: string[];
}

function validateSpecShape(parsed: unknown): { ok: true; spec: ApiSpec } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "spec is not an object" };
  const s = parsed as Record<string, unknown>;
  const method = s.method;
  if (typeof method !== "string" || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return { ok: false, reason: `spec.method must be one of GET/POST/PUT/PATCH/DELETE` };
  }
  if (typeof s.url !== "string" || !/^https:\/\/[a-zA-Z0-9.-]+/.test(s.url)) {
    return { ok: false, reason: "spec.url must be an https URL" };
  }
  const expectedStatus = s.expectedStatus;
  if (
    typeof expectedStatus !== "number" &&
    !(Array.isArray(expectedStatus) && expectedStatus.every((x) => typeof x === "number"))
  ) {
    return { ok: false, reason: "spec.expectedStatus must be a number or array of numbers" };
  }
  if (s.expectedResponseSchema !== undefined && (typeof s.expectedResponseSchema !== "object" || s.expectedResponseSchema === null)) {
    return { ok: false, reason: "spec.expectedResponseSchema must be a JSON schema object" };
  }
  if (s.headers !== undefined && (typeof s.headers !== "object" || s.headers === null)) {
    return { ok: false, reason: "spec.headers must be an object if present" };
  }
  if (s.notBody !== undefined && !(Array.isArray(s.notBody) && s.notBody.every((x) => typeof x === "string"))) {
    return { ok: false, reason: "spec.notBody must be an array of strings if present" };
  }
  return { ok: true, spec: parsed as ApiSpec };
}

export async function runApiSpec(input: RunApiSpecInput): Promise<RunApiSpecResult> {
  const {
    specPath,
    skillsRoot = "/app",
    fetchImpl = fetch,
    readFileImpl = readFile,
    requestTimeoutMs = 30_000,
  } = input;

  // Validate spec path strictly — defense in depth.
  if (!/^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.api\.spec\.(json|yaml|yml)$/.test(specPath)) {
    return {
      status: "unavailable",
      unavailableReason: `invalid spec_path format for api runner: ${specPath}`,
    };
  }

  const absPath = resolve(join(skillsRoot, specPath));
  let raw: string;
  try {
    raw = await readFileImpl(absPath, "utf8");
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec file not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const shapeCheck = validateSpecShape(parsed);
  if (!shapeCheck.ok) {
    return { status: "unavailable", unavailableReason: `spec shape invalid: ${shapeCheck.reason}` };
  }
  const spec = shapeCheck.spec;

  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(spec.url, {
      method: spec.method,
      headers: {
        accept: "application/json",
        "content-type": spec.body !== undefined ? "application/json" : "application/octet-stream",
        ...(spec.headers ?? {}),
      },
      body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `http request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const durationMs = Math.floor(Date.now() - started);

  // HTTP status check
  const acceptable = Array.isArray(spec.expectedStatus) ? spec.expectedStatus : [spec.expectedStatus];
  if (!acceptable.includes(response.status)) {
    return {
      status: "failed",
      durationMs,
      failureSummary: `expected status ${acceptable.join("|")}, got ${response.status}`,
      httpStatus: response.status,
    };
  }

  // Parse body — if content-type is JSON, parse as JSON; otherwise capture as text.
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown;
  let bodyText: string;
  try {
    bodyText = await response.text();
    if (contentType.includes("json")) {
      body = bodyText === "" ? null : JSON.parse(bodyText);
    } else {
      body = bodyText;
    }
  } catch (err) {
    return {
      status: "failed",
      durationMs,
      failureSummary: `response body was not valid JSON despite content-type=${contentType}: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus: response.status,
    };
  }

  // Negative text assertions
  if (spec.notBody && spec.notBody.length > 0) {
    for (const forbidden of spec.notBody) {
      if (bodyText.includes(forbidden)) {
        return {
          status: "failed",
          durationMs,
          failureSummary: `response body contained forbidden substring: "${forbidden.slice(0, 100)}"`,
          httpStatus: response.status,
          body,
        };
      }
    }
  }

  // JSON schema validation
  if (spec.expectedResponseSchema) {
    const ajv = new AjvClass({ allErrors: true, strict: false });
    let validate;
    try {
      validate = ajv.compile(spec.expectedResponseSchema);
    } catch (err) {
      return {
        status: "unavailable",
        unavailableReason: `expectedResponseSchema did not compile: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!validate(body)) {
      const errs: ErrorObject[] = validate.errors ?? [];
      const summary = errs
        .slice(0, 3)
        .map((e) => `${e.instancePath || "$"}: ${e.message}`)
        .join("; ");
      return {
        status: "failed",
        durationMs,
        failureSummary: `response body schema validation failed: ${summary}`,
        httpStatus: response.status,
        body,
      };
    }
  }

  return { status: "passed", durationMs, httpStatus: response.status };
}
