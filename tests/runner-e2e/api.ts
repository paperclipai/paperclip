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

  constructor(readonly request: APIRequestContext) {
    const port = process.env.PAPERCLIP_RUNNER_E2E_PORT?.trim();
    if (!port) throw new Error("PAPERCLIP_RUNNER_E2E_PORT is required");
    this.baseURL = `http://127.0.0.1:${port}`;
  }

  async get<T>(path: string, options?: { timeout: number }): Promise<T> {
    const response = await (options ? this.request.get(path, options) : this.request.get(path));
    if (!response.ok()) throw new RunnerApiHttpError(response.status(), await failureMessage(response, "GET"));
    return response.json() as Promise<T>;
  }

  async post<T>(path: string, data?: unknown): Promise<T> {
    const response = await this.request.post(path, { data });
    if (!response.ok()) throw new Error(await failureMessage(response, "POST"));
    return response.json() as Promise<T>;
  }

  /**
   * Playwright traces APIRequestContext request bodies. Secret creation must
   * still use the public API, but it goes through Node fetch so plaintext is
   * never serialized into trace/blob evidence before Paperclip encrypts it.
   */
  async postSensitive<T>(path: string, data: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseURL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw new Error(
        `Sensitive POST ${path} returned ${response.status}; response body withheld`,
      );
    }
    return response.json() as Promise<T>;
  }

  async patch<T>(path: string, data: unknown): Promise<T> {
    const response = await this.request.patch(path, { data });
    if (!response.ok())
      throw new Error(await failureMessage(response, "PATCH"));
    return response.json() as Promise<T>;
  }

  /** Use the public revision fence when configuring a fixture's instruction entry. */
  async saveAgentInstructions(agentId: string, content: string): Promise<void> {
    const path = `/api/agents/${agentId}/instructions-bundle/file`;
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
    const response = await this.request.delete(path);
    if (response.ok() || (options?.allowNotFound && response.status() === 404))
      return;
    throw new Error(await failureMessage(response, "DELETE"));
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
