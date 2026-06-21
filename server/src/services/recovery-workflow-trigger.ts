/**
 * Cloudflare Workflows REST trigger for issue recovery.
 *
 * Uses the CF Workflows Instances REST API:
 *   POST /client/v4/accounts/{accountId}/workflows/{workflowName}/instances
 *
 * Idempotency: `instance_id` is set to `actionId`.  If CF returns a
 * duplicate-instance error we treat the workflow as already started and
 * resolve normally — callers should never throw on a duplicate.
 */

export type RecoveryWorkflowTriggerConfig = {
  accountId: string;
  apiToken: string;
  workflowName: string;
  /** Optional: base URL override (for tests / local proxies). Defaults to https://api.cloudflare.com */
  baseUrl?: string;
};

export type EnsureInstanceInput = {
  companyId: string;
  actionId: string;
  sourceIssueId: string;
  mode: string;
};

export type EnsureInstanceResult = {
  instanceId: string;
};

/** Error codes / message patterns that indicate a duplicate instance_id conflict. */
function isDuplicateInstanceError(body: unknown): boolean {
  const b = body as { errors?: Array<{ code?: number; message?: string }> } | null;
  if (!b || !Array.isArray(b.errors)) return false;
  return b.errors.some(
    (e) =>
      e.code === 10006 ||
      (typeof e.message === "string" &&
        (e.message.toLowerCase().includes("already exists") ||
          e.message.toLowerCase().includes("duplicate"))),
  );
}

/**
 * Factory — validate config once, return a bound `ensureInstance` helper.
 *
 * Throws synchronously if required config is missing so the caller finds out at
 * construction time rather than at first invocation.
 */
export function recoveryWorkflowTrigger(config: RecoveryWorkflowTriggerConfig) {
  if (!config.accountId) {
    throw new Error(
      "recoveryWorkflowTrigger: accountId is required but was empty or missing",
    );
  }
  if (!config.apiToken) {
    throw new Error(
      "recoveryWorkflowTrigger: apiToken is required but was empty or missing",
    );
  }
  if (!config.workflowName) {
    throw new Error(
      "recoveryWorkflowTrigger: workflowName is required but was empty or missing",
    );
  }

  const cfBase = config.baseUrl ?? "https://api.cloudflare.com";
  const instancesUrl = `${cfBase}/client/v4/accounts/${config.accountId}/workflows/${config.workflowName}/instances`;

  async function ensureInstance(input: EnsureInstanceInput): Promise<EnsureInstanceResult> {
    const response = await fetch(instancesUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instance_id: input.actionId,
        params: {
          companyId: input.companyId,
          actionId: input.actionId,
          sourceIssueId: input.sourceIssueId,
          mode: input.mode,
        },
      }),
    });

    if (response.ok) {
      const body = (await response.json()) as { result?: { id?: string } };
      const instanceId = body.result?.id ?? input.actionId;
      return { instanceId };
    }

    // Not OK — inspect the body for duplicate-instance errors
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      throw new Error(
        `recoveryWorkflowTrigger: HTTP ${response.status} from Cloudflare Workflows API`,
      );
    }

    if (isDuplicateInstanceError(errorBody)) {
      // Already started — treat as idempotent success
      return { instanceId: input.actionId };
    }

    throw new Error(
      `recoveryWorkflowTrigger: HTTP ${response.status} from Cloudflare Workflows API: ${JSON.stringify(errorBody)}`,
    );
  }

  return { ensureInstance };
}
