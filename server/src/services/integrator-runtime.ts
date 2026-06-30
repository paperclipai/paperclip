import {
  getIntegratorSystem,
  getRegistryAction,
  type IntegratorAuth,
  type IntegratorActionRequest,
} from "@paperclipai/shared";

/**
 * Real connector runtime. Given a system's connected config/credentials and an
 * action's request spec, it performs an actual authenticated HTTP request and
 * returns the live response. No simulation.
 */

export interface RunActionInput {
  systemKey: string;
  actionKey: string;
  /** Merged connection config (base URL, etc.) + per-call inputs + credentials. */
  values: Record<string, unknown>;
}

export interface RunActionResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  method: string;
  durationMs: number;
  data: unknown;
  error?: string;
}

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

function interpolate(template: string, values: Record<string, unknown>): string {
  return template.replace(TEMPLATE_RE, (_m, key: string) => {
    const v = values[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function resolveBaseUrl(auth: IntegratorAuth, values: Record<string, unknown>): string {
  const field = auth.baseUrlField ?? "baseUrl";
  const raw = values[field];
  return typeof raw === "string" ? raw.replace(/\/+$/, "") : "";
}

function applyAuth(
  auth: IntegratorAuth,
  values: Record<string, unknown>,
  headers: Record<string, string>,
  query: URLSearchParams,
): void {
  switch (auth.scheme) {
    case "none":
      return;
    case "bearer":
    case "api_key_header": {
      const header = auth.header ?? "Authorization";
      const format = auth.format ?? "Bearer {{apiToken}}";
      const value = interpolate(format, values).trim();
      if (value && value !== "Bearer" && value !== "Token token=") headers[header] = value;
      return;
    }
    case "basic": {
      // Basic auth from username/password OR email/apiToken (Atlassian style).
      const user = (values.username ?? values.email ?? "") as string;
      const pass = (values.password ?? values.apiToken ?? values.apiKey ?? "") as string;
      if (user || pass) {
        headers["Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      }
      return;
    }
    case "api_key_query": {
      if (auth.queryParam) {
        const v = interpolate(auth.format ?? "{{apiToken}}", values).trim();
        if (v) query.set(auth.queryParam, v);
      }
      return;
    }
  }
}

function buildRequest(
  auth: IntegratorAuth,
  spec: IntegratorActionRequest,
  values: Record<string, unknown>,
): { url: string; method: string; headers: Record<string, string>; body?: string } {
  const base = resolveBaseUrl(auth, values);
  // For the generic http connector the method can come from inputs.
  const method = (typeof values.method === "string" && values.method.trim()
    ? String(values.method).trim().toUpperCase()
    : spec.method) as string;
  let path = interpolate(spec.path, values);
  if (path && !path.startsWith("/") && !path.startsWith("http")) path = `/${path}`;
  const isAbsolute = path.startsWith("http");
  const url = new URL(isAbsolute ? path : `${base}${path}`);
  const query = url.searchParams;
  if (spec.query) {
    for (const [k, v] of Object.entries(spec.query)) {
      const val = interpolate(v, values);
      if (val) query.set(k, val);
    }
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (spec.headers) {
    for (const [k, v] of Object.entries(spec.headers)) headers[k] = interpolate(v, values);
  }
  applyAuth(auth, values, headers, query);

  let body: string | undefined;
  const rawBody = spec.body ?? (typeof values.body === "string" ? (values.body as string) : undefined);
  if (rawBody && method !== "GET" && method !== "DELETE") {
    body = interpolate(rawBody, values);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }

  return { url: url.toString(), method, headers, body };
}

export async function runIntegratorAction(
  input: RunActionInput,
  opts: { timeoutMs?: number } = {},
): Promise<RunActionResult> {
  const system = getIntegratorSystem(input.systemKey);
  const action = getRegistryAction(input.systemKey, input.actionKey);
  if (!system || !action) {
    return {
      ok: false,
      status: 0,
      statusText: "unknown_action",
      url: "",
      method: "",
      durationMs: 0,
      data: null,
      error: `Unknown integrator action ${input.systemKey}.${input.actionKey}`,
    };
  }

  const { url, method, headers, body } = buildRequest(system.auth, action.request, input.values);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url,
      method,
      durationMs: Date.now() - started,
      data,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      statusText: "request_failed",
      url,
      method,
      durationMs: Date.now() - started,
      data: null,
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}
