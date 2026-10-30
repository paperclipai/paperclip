import type { APIRequestContext, APIResponse } from "@playwright/test";

export interface JsonRecord {
  [key: string]: unknown;
}

async function failureMessage(response: APIResponse, method: string) {
  const text = await response.text().catch(() => "");
  return `${method} ${response.url()} returned ${response.status()}${text ? `: ${text}` : ""}`;
}

/** Preserve HTTP status independently of diagnostic response text. */
export class RunnerApiHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "RunnerApiHttpError"; }
}

/** Admission-only diagnostics. Never retain the rejected value or its cause. */
export class RemoteAdmissionReadError extends Error {
  constructor(
    readonly endpoint: "issue" | "run" | "leases",
    readonly failureClass: "candidate_failure" | "transient_infrastructure" | "permanent_infrastructure",
  ) {
    super(`Remote admission ${endpoint} read failed (${failureClass}); diagnostics withheld`);
    this.name = "RemoteAdmissionReadError";
  }
}

export class RunnerApi {
  readonly baseURL: string;
  private browserCookie?: string;

  setBrowserSession(cookie: string) { this.browserCookie = cookie; }
  private sessionOptions() {
    return this.browserCookie ? { headers: { Cookie: this.browserCookie, Origin: this.baseURL } } : {};
  }

  constructor(readonly request: APIRequestContext) {
    const port = process.env.PAPERCLIP_RUNNER_E2E_PORT?.trim();
    if (!port) throw new Error("PAPERCLIP_RUNNER_E2E_PORT is required");
    this.baseURL = `http://127.0.0.1:${port}`;
  }

  async get<T>(path: string, options?: { timeout: number }): Promise<T> {
    if (this.browserCookie) return this.authenticatedJson<T>("GET", path, undefined, options);
    const response = await this.request.get(path, { ...this.sessionOptions(), ...options });
    if (!response.ok()) throw new RunnerApiHttpError(response.status(), await failureMessage(response, "GET"));
    return response.json() as Promise<T>;
  }

  async bytes(path: string): Promise<Buffer> {
    const response = await this.request.get(path, this.sessionOptions());
    if (!response.ok()) throw new RunnerApiHttpError(response.status(), await failureMessage(response, "GET"));
    return response.body();
  }


  /** Restricted trace inspection bypasses browser trace capture; callers retain only bounded timing fields. */
  async getProviderTraceInspection<T>(runId: string): Promise<T> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId)) throw new Error("Invalid diagnostic run identity");
    return this.authenticatedJson<T>("GET", `/api/heartbeat-runs/${runId}/provider-trace`);
  }

  /** Repeated native observation reads retain explicit snapshots, without duplicating full DTO bodies in the browser trace. */
  async getRunObservation<T>(path: string, options?: { timeout: number }): Promise<T> {
    const url = new URL(path, this.baseURL);
    const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    const companyRuns = new RegExp(`^/api/companies/${uuid}/heartbeat-runs$`, "i").test(url.pathname)
      && [...url.searchParams.keys()].every(key => key === "limit") && url.searchParams.get("limit") === "100";
    const run = new RegExp(`^/api/heartbeat-runs/${uuid}$`, "i").test(url.pathname) && !url.search;
    const events = new RegExp(`^/api/heartbeat-runs/${uuid}/events$`, "i").test(url.pathname)
      && [...url.searchParams.keys()].every(key => ["afterSeq", "limit"].includes(key))
      && /^\d+$/.test(url.searchParams.get("afterSeq") ?? "") && /^[1-9]\d*$/.test(url.searchParams.get("limit") ?? "");
    if (url.origin !== this.baseURL || url.username || url.password || url.hash || !(companyRuns || run || events)) throw new Error("Run observation requires an allowlisted same-origin GET endpoint");
    return this.authenticatedJson<T>("GET", path, undefined, options);
  }

  /** Fetch owned attachment bytes with the same authenticated actor as JSON reads. */
  async getAttachmentContent(attachmentId: string): Promise<Buffer> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(attachmentId)) throw new Error("Invalid fixture attachment identity");
    if (this.browserCookie) {
      const path = `/api/attachments/${attachmentId}/content`; const response = await this.authenticatedResponse("GET", path);
      if (!response.ok) { await response.body?.cancel(); throw new RunnerApiHttpError(response.status, `GET ${path} returned ${response.status}; body withheld`); }
      try { return Buffer.from(await response.arrayBuffer()); } catch { throw new Error(`GET ${path} byte response failed; details withheld`); }
    }
    const response = await this.request.get(`/api/attachments/${attachmentId}/content`, this.sessionOptions());
    if (!response.ok()) throw new RunnerApiHttpError(response.status(), await failureMessage(response, "GET"));
    return response.body();
  }

  async post<T>(path: string, data?: unknown, options?: { timeout: number }): Promise<T> {
    if (this.browserCookie) return this.authenticatedJson<T>("POST", path, data, options);
    const response = await this.request.post(path, { data, ...this.sessionOptions(), ...options });
    if (!response.ok()) throw new Error(await failureMessage(response, "POST"));
    return response.json() as Promise<T>;
  }

  /**
   * Playwright traces APIRequestContext request bodies. Secret creation must
   * still use the public API, but it goes through Node fetch so plaintext is
   * never serialized into trace/blob evidence before Paperclip encrypts it.
   */
  async postSensitive<T>(path: string, data: unknown): Promise<T> {
    return this.sensitive<T>("POST", path, data);
  }

  async putSensitive<T>(path: string, data: unknown): Promise<T> {
    return this.sensitive<T>("PUT", path, data);
  }

  async patchSensitive<T>(path: string, data: unknown): Promise<T> {
    return this.sensitive<T>("PATCH", path, data);
  }

  private async sensitive<T>(method: "POST" | "PUT" | "PATCH", path: string, data: unknown): Promise<T> {
    const url = new URL(path, this.baseURL);
    if (url.origin !== this.baseURL || !url.pathname.startsWith("/api/")) throw new Error("Sensitive request must use the fixture API");
    let response: Response;
    try {
      response = await fetch(url, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", ...this.sessionOptions().headers },
        body: JSON.stringify(data),
      });
    } catch { throw new Error(`Sensitive ${method} request failed; details withheld`); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Sensitive ${method} ${url.pathname} returned ${response.status}; response body withheld`);
    }
    try { return await response.json() as T; } catch { throw new Error(`Sensitive ${method} ${url.pathname} returned invalid JSON; response body withheld`); }
  }

  async patch<T>(path: string, data: unknown): Promise<T> {
    if (this.browserCookie) return this.authenticatedJson<T>("PATCH", path, data);
    const response = await this.request.patch(path, { data, ...this.sessionOptions() });
    if (!response.ok())
      throw new Error(await failureMessage(response, "PATCH"));
    return response.json() as Promise<T>;
  }

  /** Use the public revision fence when configuring a fixture's instruction entry. */
  async saveAgentInstructions(agentId: string, content: string): Promise<void> {
    const path = `/api/agents/${agentId}/instructions-bundle/file`;
    if (this.browserCookie) {
      let baseHash: string | null = null;
      try {
        const detail = await this.authenticatedJson<{ contentHash: string }>("GET", `${path}?path=AGENTS.md`);
        if (typeof detail.contentHash !== "string" || !detail.contentHash) throw new Error("Existing fixture instructions have no revision hash");
        baseHash = detail.contentHash;
      } catch (error) { if (!(error instanceof RunnerApiHttpError) || error.status !== 404) throw error; }
      await this.authenticatedJson("PUT", path, { path: "AGENTS.md", content, baseHash }); return;
    }
    const current = await this.request.get(`${path}?path=AGENTS.md`);
    let baseHash: string | null = null;
    if (current.ok()) {
      const detail = await current.json();
      if (typeof detail.contentHash !== "string" || !detail.contentHash) {
        throw new Error("Existing fixture instructions have no revision hash");
      }
      baseHash = detail.contentHash;
    } else if (current.status() !== 404) {
      throw new Error(await failureMessage(current, "GET"));
    }
    const saved = await this.request.put(path, { data: { path: "AGENTS.md", content, baseHash } });
    if (!saved.ok()) throw new Error(await failureMessage(saved, "PUT"));
  }

  async delete(
    path: string,
    options?: { allowNotFound?: boolean },
  ): Promise<void> {
    if (this.browserCookie) {
      const response = await this.authenticatedResponse("DELETE", path); await response.body?.cancel();
      if (response.ok || options?.allowNotFound && response.status === 404) return;
      throw new RunnerApiHttpError(response.status, `DELETE ${new URL(path, this.baseURL).pathname} returned ${response.status}; body withheld`);
    }
    const response = await this.request.delete(path, this.sessionOptions());
    if (response.ok() || (options?.allowNotFound && response.status() === 404))
      return;
    throw new Error(await failureMessage(response, "DELETE"));
  }

  /** Explicit session cookies never become Playwright API-step parameters.
   * Public responses remain untouched for independent product/leak oracles. */
  private async authenticatedResponse(method: string, path: string, data?: unknown, options?: { timeout: number }): Promise<Response> {
    const url = new URL(path, this.baseURL);
    if (url.origin !== this.baseURL || !url.pathname.startsWith("/api/")) throw new Error("Authenticated request must use the fixture API");
    const timeout = options?.timeout ?? 30_000;
    try {
      return await fetch(url, { method, redirect: "error", ...(timeout === 0 ? {} : { signal: AbortSignal.timeout(timeout) }),
        headers: { "content-type": "application/json", ...this.sessionOptions().headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    } catch { throw new Error(`Authenticated ${method} ${url.pathname} connection request failed; details withheld`); }
  }

  private async authenticatedJson<T>(method: string, path: string, data?: unknown, options?: { timeout: number }): Promise<T> {
    const response = await this.authenticatedResponse(method, path, data, options);
    const endpoint = new URL(path, this.baseURL).pathname;
    if (!response.ok) { await response.body?.cancel(); throw new RunnerApiHttpError(response.status, `${method} ${endpoint} returned ${response.status}; body withheld`); }
    try { return await response.json() as T; } catch { throw new Error(`${method} ${endpoint} returned ${response.status} with invalid JSON; body withheld`); }
  }
}

export class ObservedStateTimeout extends Error {
  constructor(label: string, readonly failureClass: "candidate_failure" | "transient_infrastructure", detail?: string) {
    super(`Timed out waiting for ${label}; ${detail ?? "the observed state did not satisfy the condition"}. See the saved state evidence.`);
    this.name = "ObservedStateTimeout";
  }
}

export async function pollUntil<T>(input: {
  label: string;
  deadlineAt: number;
  load: () => Promise<T>;
  accept: (value: T) => boolean;
  reject?: (value: T) => string | undefined;
  intervalMs?: number;
  retryOnError?: (error: unknown) => boolean;
  timeoutFailureClass?: "candidate_failure" | "transient_infrastructure";
  timeoutDetail?: (value: T | undefined) => string | undefined;
}): Promise<T> {
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < input.deadlineAt) {
    try {
      last = await input.load();
      if (input.accept(last)) return last;
      const rejection = input.reject?.(last);
      if (rejection) {
        throw new Error(`Stopped waiting for ${input.label}: ${rejection}`);
      }
      lastError = undefined;
    } catch (error) {
      if (input.retryOnError && !input.retryOnError(error)) throw error;
      if (
        error instanceof Error &&
        error.message.startsWith(`Stopped waiting for ${input.label}:`)
      ) {
        throw error;
      }
      lastError = error;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, input.intervalMs ?? 2_000),
    );
  }
  if (lastError instanceof Error) {
    throw new Error(`Timed out waiting for ${input.label}: ${lastError.message}`, { cause: lastError });
  }
  throw new ObservedStateTimeout(
    input.label,
    input.timeoutFailureClass ?? "candidate_failure",
    input.timeoutDetail?.(last),
  );
}
