export interface DpoClientOptions {
  baseUrl: string;
  sharedKey: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface ClientAnonymizeInput {
  text: string;
  targetLlm: string;
  agent: string;
  tenantId?: string;
}

export type ClientAnonymizeResult =
  | { blocked: false; anonymizedText: string; mappingId: string }
  | { blocked: true; reason: string };

export interface ClientSafeCallInput {
  prompt: string;
  targetLlm: string;
  agent: string;
  tenantId?: string;
  external: {
    url: string;
    method?: "POST" | "PUT";
    headers?: Record<string, string>;
    bodyTemplate: Record<string, unknown>;
    responsePath: string;
  };
}

export type ClientSafeCallResult =
  | { blocked: false; text: string }
  | { blocked: true; reason: string };

export interface DpoClient {
  anonymize(input: ClientAnonymizeInput): Promise<ClientAnonymizeResult>;
  deanonymize(input: { mappingId: string; text: string }): Promise<{ text: string }>;
  safeCall(input: ClientSafeCallInput): Promise<ClientSafeCallResult>;
  health(): Promise<{ status: string; classifier: string }>;
}

export function createDpoClient(opts: DpoClientOptions): DpoClient {
  const f = opts.fetchFn ?? fetch;
  const timeout = opts.timeoutMs ?? 60_000;
  const base = opts.baseUrl.replace(/\/$/, "");

  async function post<T>(path: string, body: unknown, requireAuth = true): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (requireAuth) headers["x-dpo-key"] = opts.sharedKey;
      const res = await f(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`dpo ${path} ${res.status}: ${await res.text().catch(() => "")}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    anonymize: (input) => post<ClientAnonymizeResult>("/anonymize", input),
    deanonymize: (input) => post<{ text: string }>("/deanonymize", input),
    safeCall: (input) => post<ClientSafeCallResult>("/safe-call", input),
    async health() {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await f(`${base}/health`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`health ${res.status}`);
        return (await res.json()) as { status: string; classifier: string };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
