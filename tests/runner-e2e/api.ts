import type { APIRequestContext, APIResponse } from "@playwright/test";

export interface JsonRecord {
  [key: string]: unknown;
}

async function failureMessage(response: APIResponse, method: string) {
  const text = await response.text().catch(() => "");
  return `${method} ${response.url()} returned ${response.status()}${text ? `: ${text}` : ""}`;
}

export class RunnerApi {
  readonly baseURL: string;

  constructor(readonly request: APIRequestContext) {
    const port = process.env.PAPERCLIP_RUNNER_E2E_PORT?.trim();
    if (!port) throw new Error("PAPERCLIP_RUNNER_E2E_PORT is required");
    this.baseURL = `http://127.0.0.1:${port}`;
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.request.get(path);
    if (!response.ok()) throw new Error(await failureMessage(response, "GET"));
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

export async function pollUntil<T>(input: {
  label: string;
  deadlineAt: number;
  load: () => Promise<T>;
  accept: (value: T) => boolean;
  reject?: (value: T) => string | undefined;
  intervalMs?: number;
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
  const detail =
    lastError instanceof Error
      ? lastError.message
      : last === undefined
        ? "no observation"
        : JSON.stringify(last);
  throw new Error(`Timed out waiting for ${input.label}: ${detail}`);
}
