import type {
  DeliveryEventState,
  ExternalOperationKind,
  ExternalOperationState,
  ExternalOperationV1,
} from "@paperclipai/shared";

export type ExternalProviderVerification = {
  provider: string;
  externalId: string;
  operationState: ExternalOperationState;
  eventState: DeliveryEventState;
  candidateSha: string | null;
  environment: string | null;
  url: string | null;
  /** Provider-owned operation creation/start time, distinct from its latest update. */
  startedAt?: Date | null;
  observedAt: Date;
  summary: string;
  metadata: Record<string, unknown>;
};

export type ExternalOperationVerifierInput = {
  operation: ExternalOperationV1;
  credential: string;
  apiBase?: string;
};

export interface ExternalOperationVerifier {
  readonly provider: string;
  readonly kind: ExternalOperationKind;
  verify(input: ExternalOperationVerifierInput): Promise<ExternalProviderVerification>;
}

/**
 * A provider response that permanently disproves the registered operation's
 * board-bound identity. These failures terminalize the operation so a corrected
 * provider run can supersede it immediately; transport/provider outages remain
 * ordinary retryable errors.
 */
export class ExternalProviderAttestationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ExternalProviderAttestationError";
    this.code = code;
  }
}

type FetchLike = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function providerId(value: unknown, fallback: string) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return stringOrNull(value) ?? fallback;
}

function githubWorkflowRunPath(value: unknown) {
  const rawPath = stringOrNull(value);
  if (!rawPath) return { rawPath: null, path: null, ref: null };
  const separator = rawPath.lastIndexOf("@");
  if (separator <= 0 || separator === rawPath.length - 1) {
    return { rawPath, path: rawPath, ref: null };
  }
  return {
    rawPath,
    path: rawPath.slice(0, separator),
    ref: rawPath.slice(separator + 1),
  };
}

function providerDate(value: unknown, provider: string) {
  const raw = stringOrNull(value);
  if (!raw) throw new Error(`${provider} response is missing a provider observation timestamp`);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${provider} response contains an invalid provider observation timestamp`);
  }
  return parsed;
}

async function providerJson(response: Response, provider: string) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = asRecord(payload);
    const errors = Array.isArray(record.errors) ? record.errors : [];
    const firstError = asRecord(errors[0]);
    const message = stringOrNull(record.message) ?? stringOrNull(firstError.message);
    throw new Error(message ?? `${provider} returned ${response.status}`);
  }
  return asRecord(payload);
}

function githubState(status: string | null, conclusion: string | null): {
  operationState: ExternalOperationState;
  eventState: DeliveryEventState;
} {
  if (status !== "completed") {
    if (status === "queued" || status === "waiting" || status === "pending") {
      return { operationState: "queued", eventState: "pending" };
    }
    if (status === "in_progress" || status === "requested") {
      return { operationState: "running", eventState: "pending" };
    }
    return { operationState: "unknown", eventState: "unknown" };
  }
  if (conclusion === "success") return { operationState: "succeeded", eventState: "succeeded" };
  if (conclusion === "cancelled" || conclusion === "skipped" || conclusion === "neutral") {
    return { operationState: "cancelled", eventState: conclusion === "skipped" ? "skipped" : "failed" };
  }
  return { operationState: "failed", eventState: "failed" };
}

export function createGithubActionsVerifier(fetchImpl: FetchLike = fetch): ExternalOperationVerifier {
  return {
    provider: "github",
    kind: "github_actions_workflow_run",
    async verify({ operation, credential, apiBase = "https://api.github.com" }) {
      const metadata = asRecord(operation.metadata);
      const owner = stringOrNull(metadata.owner);
      const repo = stringOrNull(metadata.repo);
      if (!owner || !repo) {
        throw new Error("GitHub Actions verification requires metadata.owner and metadata.repo");
      }
      const expectedWorkflowPath = stringOrNull(metadata.githubWorkflowPath);
      const expectedWorkflowBlobSha = stringOrNull(metadata.githubWorkflowBlobSha)?.toLowerCase() ?? null;
      const expectedWorkflowEvent = stringOrNull(metadata.githubWorkflowEvent)?.toLowerCase() ?? null;
      if (!expectedWorkflowPath || !expectedWorkflowBlobSha || !expectedWorkflowEvent) {
        throw new ExternalProviderAttestationError(
          "GitHub Actions verification requires the server-bound workflow path, blob SHA, and event",
          "github_workflow_attestation_missing",
        );
      }
      const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${credential}`,
        "User-Agent": "paperclip-delivery-verifier",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      const normalizedApiBase = apiBase.replace(/\/$/, "");
      const response = await fetchImpl(
        `${normalizedApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(operation.externalId)}`,
        {
          headers,
          signal: AbortSignal.timeout(15_000),
        },
      );
      const payload = await providerJson(response, "GitHub");
      const workflowRunPath = githubWorkflowRunPath(payload.path);
      const workflowPath = workflowRunPath.path;
      const workflowEvent = stringOrNull(payload.event)?.toLowerCase() ?? null;
      const headSha = stringOrNull(payload.head_sha)?.toLowerCase() ?? null;
      const startedAt = providerDate(payload.run_started_at ?? payload.created_at, "GitHub");
      const observedAt = providerDate(payload.updated_at ?? payload.created_at, "GitHub");
      if (workflowPath !== expectedWorkflowPath) {
        throw new ExternalProviderAttestationError(
          "GitHub Actions run workflow path does not match the board-pinned workflow path",
          "github_workflow_path_mismatch",
        );
      }
      if (workflowEvent !== expectedWorkflowEvent) {
        throw new ExternalProviderAttestationError(
          "GitHub Actions run event does not match the board-allowed workflow event",
          "github_workflow_event_mismatch",
        );
      }
      if (!headSha) {
        throw new ExternalProviderAttestationError(
          "GitHub Actions response is missing the run head SHA required for workflow attestation",
          "github_workflow_head_sha_missing",
        );
      }
      const encodedWorkflowPath = expectedWorkflowPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const workflowResponse = await fetchImpl(
        `${normalizedApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedWorkflowPath}?ref=${encodeURIComponent(headSha)}`,
        {
          headers,
          signal: AbortSignal.timeout(15_000),
        },
      );
      const workflowPayload = await providerJson(workflowResponse, "GitHub");
      const workflowBlobSha = stringOrNull(workflowPayload.sha)?.toLowerCase() ?? null;
      if (stringOrNull(workflowPayload.type)?.toLowerCase() !== "file" || !workflowBlobSha) {
        throw new ExternalProviderAttestationError(
          "GitHub Contents response did not attest to a workflow file blob",
          "github_workflow_blob_missing",
        );
      }
      if (workflowBlobSha !== expectedWorkflowBlobSha) {
        throw new ExternalProviderAttestationError(
          "GitHub Actions workflow blob does not match the board-pinned workflow definition",
          "github_workflow_blob_mismatch",
        );
      }
      const status = stringOrNull(payload.status)?.toLowerCase() ?? null;
      const conclusion = stringOrNull(payload.conclusion)?.toLowerCase() ?? null;
      const state = githubState(status, conclusion);
      const runId = providerId(payload.id, operation.externalId);
      return {
        provider: "github",
        externalId: runId,
        ...state,
        candidateSha: stringOrNull(payload.head_sha),
        // GitHub workflow runs do not attest to a deployment environment.
        // Never elevate the caller's expected environment into provider truth.
        environment: null,
        url: stringOrNull(payload.html_url),
        startedAt,
        observedAt,
        summary: conclusion
          ? `GitHub Actions run ${runId} completed with ${conclusion}`
          : `GitHub Actions run ${runId} is ${status ?? "unknown"}`,
        metadata: {
          owner,
          repo,
          repositoryFullName: stringOrNull(asRecord(payload.repository).full_name),
          workflowId: payload.workflow_id ?? null,
          workflowPath,
          workflowRawPath: workflowRunPath.rawPath,
          workflowRef: workflowRunPath.ref,
          workflowEvent,
          workflowBlobSha,
          workflowBlobHeadSha: headSha,
          runNumber: payload.run_number ?? null,
          runAttempt: payload.run_attempt ?? null,
          status,
          conclusion,
        },
      };
    },
  };
}

function cloudflareState(status: string | null): {
  operationState: ExternalOperationState;
  eventState: DeliveryEventState;
} {
  if (status === "success") return { operationState: "succeeded", eventState: "succeeded" };
  if (status === "failure" || status === "failed") return { operationState: "failed", eventState: "failed" };
  if (status === "cancelled" || status === "canceled") return { operationState: "cancelled", eventState: "failed" };
  if (status === "active" || status === "running" || status === "building") {
    return { operationState: "running", eventState: "pending" };
  }
  if (status === "idle" || status === "queued" || status === "pending") {
    return { operationState: "queued", eventState: "pending" };
  }
  return { operationState: "unknown", eventState: "unknown" };
}

export function createCloudflarePagesVerifier(fetchImpl: FetchLike = fetch): ExternalOperationVerifier {
  return {
    provider: "cloudflare",
    kind: "cloudflare_pages_deployment",
    async verify({ operation, credential, apiBase = "https://api.cloudflare.com/client/v4" }) {
      const metadata = asRecord(operation.metadata);
      const accountId = stringOrNull(metadata.cloudflareAccountId);
      const projectName = stringOrNull(metadata.cloudflareProjectName);
      if (!accountId || !projectName) {
        throw new Error("Cloudflare Pages verification requires metadata.accountId and metadata.projectName");
      }
      const response = await fetchImpl(
        `${apiBase.replace(/\/$/, "")}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments/${encodeURIComponent(operation.externalId)}`,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential}`,
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const envelope = await providerJson(response, "Cloudflare");
      const payload = asRecord(envelope.result);
      const latestStage = asRecord(payload.latest_stage);
      const trigger = asRecord(payload.deployment_trigger);
      const triggerMetadata = asRecord(trigger.metadata);
      const status = stringOrNull(latestStage.status)?.toLowerCase() ?? null;
      const state = cloudflareState(status);
      const deploymentId = providerId(payload.id, operation.externalId);
      return {
        provider: "cloudflare",
        externalId: deploymentId,
        ...state,
        candidateSha: stringOrNull(triggerMetadata.commit_hash),
        environment: stringOrNull(payload.environment),
        url: stringOrNull(payload.url),
        startedAt: providerDate(payload.created_on, "Cloudflare"),
        observedAt: providerDate(
          payload.modified_on ?? latestStage.ended_on ?? payload.created_on,
          "Cloudflare",
        ),
        summary: `Cloudflare Pages deployment ${deploymentId} is ${status ?? "unknown"}`,
        metadata: {
          accountId,
          projectName,
          status,
          stageName: stringOrNull(latestStage.name),
          shortId: stringOrNull(payload.short_id),
        },
      };
    },
  };
}

export function defaultExternalOperationVerifiers(fetchImpl: FetchLike = fetch) {
  const verifiers = [
    createGithubActionsVerifier(fetchImpl),
    createCloudflarePagesVerifier(fetchImpl),
  ];
  return new Map(verifiers.map((verifier) => [`${verifier.provider}:${verifier.kind}`, verifier]));
}
