/**
 * Internal API client for the RecoveryWorkflow.
 *
 * All requests include the x-internal-secret header for authentication.
 * Throws on non-2xx responses.
 */

interface ClientEnv {
  INTERNAL_API_BASE_URL: string;
  INTERNAL_API_SECRET: string;
}

export interface AttemptRequest {
  companyId: string;
  actionId: string;
  sourceIssueId: string;
  attemptNumber: number;
  // WIRE vocabulary expected by the server attempt endpoint: "dry" (no writes,
  // shadow) | "active" (real writes). This is intentionally NOT the workflow's
  // authority mode ("shadow"|"active") — the loop translates shadow->dry before
  // calling. Keeping this typed as the wire enum makes tsc reject a stray
  // "shadow" so the two halves of the seam cannot drift again.
  mode: "dry" | "active";
}

export interface AttemptResponse {
  active: boolean;
  status: string;
  attemptCount: number;
  nextIntervalMs: number;
}

export interface GetStateRequest {
  companyId: string;
  actionId: string;
  sourceIssueId: string;
}

export interface GetStateResponse {
  active: boolean;
  status: string;
  attemptCount: number;
}

export interface InternalClient {
  attempt(req: AttemptRequest): Promise<AttemptResponse>;
  getState(req: GetStateRequest): Promise<GetStateResponse>;
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Internal API error ${res.status}: ${text}`);
  }
}

export function makeInternalClient(env: ClientEnv): InternalClient {
  const { INTERNAL_API_BASE_URL: base, INTERNAL_API_SECRET: secret } = env;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-internal-secret": secret,
  };

  return {
    async attempt({ companyId, actionId, sourceIssueId, attemptNumber, mode }) {
      const url = `${base}/internal/recovery/${actionId}/attempt`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ companyId, sourceIssueId, attemptNumber, mode }),
      });
      await throwIfNotOk(res);
      return res.json() as Promise<AttemptResponse>;
    },

    async getState({ companyId, actionId, sourceIssueId }) {
      const params = new URLSearchParams({ companyId, sourceIssueId });
      const url = `${base}/internal/recovery/${actionId}?${params.toString()}`;
      const res = await fetch(url, {
        method: "GET",
        headers,
      });
      await throwIfNotOk(res);
      return res.json() as Promise<GetStateResponse>;
    },
  };
}
