const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_COMMENT_PAGES = 20;

export interface LinearSecretRef {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
}

export type LinearSecretOperation = "find_comment" | "create_comment" | "get_comment";

/**
 * Deployment-owned secret resolution boundary. The resolved value must remain
 * in process memory and must never be returned to Paperclip core.
 */
export interface LinearSecretResolver {
  resolve(input: {
    secretRef: LinearSecretRef;
    purpose: "linear_evidence_comment_transport";
    operation: LinearSecretOperation;
  }): Promise<string>;
}

export interface LinearCommentReceipt {
  id: string;
  linearIssueId: string;
  body: string;
  createdAt: string;
}

/** Structurally implements Paperclip core's credential-free transport port. */
export interface LinearEvidenceTransport {
  findCommentByMarker(input: { linearIssueId: string; marker: string }): Promise<LinearCommentReceipt | null>;
  createComment(input: { linearIssueId: string; body: string }): Promise<{ id: string }>;
  getComment(input: { linearIssueId: string; commentId: string }): Promise<LinearCommentReceipt | null>;
}

export type LinearEvidenceTransportErrorCode =
  | "invalid_request"
  | "unsafe_comment_body"
  | "secret_resolution_failed"
  | "network_error"
  | "delivery_ambiguous"
  | "remote_rejected"
  | "remote_protocol_error"
  | "remote_conflict";

/**
 * Deliberately contains only bounded metadata. Remote and resolver messages are
 * never retained because either may echo authorization material.
 */
export class LinearEvidenceTransportError extends Error {
  constructor(
    public readonly code: LinearEvidenceTransportErrorCode,
    public readonly metadata: Readonly<{
      status?: number;
      requestId?: string;
      remoteCode?: string;
    }> = {},
  ) {
    super(`Linear evidence transport failed: ${code}`);
    this.name = "LinearEvidenceTransportError";
  }
}

export interface CreateLinearEvidenceTransportOptions {
  authorizationSecretRef: LinearSecretRef;
  secretResolver: LinearSecretResolver;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

type GraphqlEnvelope<T> = {
  data?: T | null;
  errors?: Array<{ extensions?: { code?: unknown } }>;
};

type RemoteComment = {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  issue?: { id?: unknown; identifier?: unknown } | null;
};

function boundedOpaque(value: unknown, max = 256): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function safeRemoteMetadata(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return undefined;
  return value;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function containsCredentialMaterial(value: string): boolean {
  return (
    /\b(?:authorization|api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|client[-_]?secret)\s*[:=]\s*(?!<redacted>|\[redacted\])\S{8,}/i.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i.test(value) ||
    /\b(?:sk|lin_api)_[A-Za-z0-9_-]{12,}\b/.test(value)
  );
}

function requireIssueId(value: string): string {
  const parsed = boundedOpaque(value);
  if (!parsed) throw new LinearEvidenceTransportError("invalid_request");
  return parsed;
}

function requireCommentId(value: string): string {
  const parsed = boundedOpaque(value);
  if (!parsed) throw new LinearEvidenceTransportError("invalid_request");
  return parsed;
}

function requireMarker(value: string): string {
  if (
    value.length > 2_048 ||
    !/^<!-- paperclip-evidence:[^\r\n]+ -->$/.test(value)
  ) throw new LinearEvidenceTransportError("invalid_request");
  return value;
}

function issueMatches(issue: RemoteComment["issue"], requested: string): boolean {
  return issue?.id === requested || issue?.identifier === requested;
}

function commentReceipt(comment: RemoteComment, requestedIssueId: string): LinearCommentReceipt {
  const id = boundedOpaque(comment.id);
  if (!id || typeof comment.body !== "string" || !validIso(comment.createdAt) || !issueMatches(comment.issue, requestedIssueId)) {
    throw new LinearEvidenceTransportError("remote_conflict");
  }
  return { id, linearIssueId: requestedIssueId, body: comment.body, createdAt: comment.createdAt };
}

async function parseEnvelope<T>(response: Response): Promise<GraphqlEnvelope<T>> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new LinearEvidenceTransportError("remote_protocol_error", {
      status: response.status,
      requestId: safeRemoteMetadata(response.headers.get("x-request-id") ?? response.headers.get("linear-request-id")),
    });
  }
  const requestId = safeRemoteMetadata(response.headers.get("x-request-id") ?? response.headers.get("linear-request-id"));
  if (raw.length > MAX_RESPONSE_BYTES) {
    throw new LinearEvidenceTransportError("remote_protocol_error", { status: response.status, requestId });
  }
  if (!response.ok) {
    throw new LinearEvidenceTransportError("remote_rejected", { status: response.status, requestId });
  }
  try {
    const parsed = JSON.parse(raw) as GraphqlEnvelope<T>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid envelope");
    return parsed;
  } catch {
    throw new LinearEvidenceTransportError("remote_protocol_error", { status: response.status, requestId });
  }
}

function firstRemoteCode(errors: GraphqlEnvelope<unknown>["errors"]): string | undefined {
  return safeRemoteMetadata(errors?.[0]?.extensions?.code);
}

export function createLinearEvidenceTransport(options: CreateLinearEvidenceTransportOptions): LinearEvidenceTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    !options.authorizationSecretRef ||
    options.authorizationSecretRef.type !== "secret_ref" ||
    "authorization" in options ||
    "apiKey" in options ||
    "token" in options
  ) {
    // This boundary accepts references only. Direct credential-shaped options
    // are rejected even if supplied by an untyped JavaScript caller.
    throw new LinearEvidenceTransportError("invalid_request");
  }
  const secretId = boundedOpaque(options.authorizationSecretRef.secretId);
  const version = options.authorizationSecretRef.version === undefined
    ? undefined
    : options.authorizationSecretRef.version === "latest"
      ? "latest"
      : Number.isSafeInteger(options.authorizationSecretRef.version) && options.authorizationSecretRef.version > 0
        ? options.authorizationSecretRef.version
        : null;
  if (!secretId || (options.authorizationSecretRef.version !== undefined && !version) || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new LinearEvidenceTransportError("invalid_request");
  }
  const secretRef = Object.freeze({ type: "secret_ref" as const, secretId, ...(version ? { version } : {}) });

  async function request<T>(input: {
    operation: LinearSecretOperation;
    query: string;
    variables: Record<string, unknown>;
    mutation: boolean;
  }): Promise<T> {
    let authorization: string;
    try {
      authorization = await options.secretResolver.resolve({
        secretRef,
        purpose: "linear_evidence_comment_transport",
        operation: input.operation,
      });
    } catch {
      throw new LinearEvidenceTransportError("secret_resolution_failed");
    }
    if (typeof authorization !== "string" || !authorization.trim() || /[\r\n]/.test(authorization)) {
      throw new LinearEvidenceTransportError("secret_resolution_failed");
    }

    let response: Response;
    try {
      response = await fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: input.query, variables: input.variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new LinearEvidenceTransportError(input.mutation ? "delivery_ambiguous" : "network_error");
    } finally {
      authorization = "";
    }

    const envelope = await parseEnvelope<T>(response);
    if (envelope.errors?.length) {
      throw new LinearEvidenceTransportError("remote_rejected", {
        status: response.status,
        requestId: safeRemoteMetadata(response.headers.get("x-request-id") ?? response.headers.get("linear-request-id")),
        remoteCode: firstRemoteCode(envelope.errors),
      });
    }
    if (envelope.data === undefined || envelope.data === null) {
      throw new LinearEvidenceTransportError("remote_protocol_error", { status: response.status });
    }
    return envelope.data;
  }

  async function findCommentByMarker(input: { linearIssueId: string; marker: string }) {
    const linearIssueId = requireIssueId(input.linearIssueId);
    const marker = requireMarker(input.marker);
    let after: string | null = null;
    const matches: LinearCommentReceipt[] = [];

    for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
      const data = await request<{
        issue?: {
          id?: unknown;
          identifier?: unknown;
          comments?: {
            nodes?: RemoteComment[];
            pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
          };
        } | null;
      }>({
        operation: "find_comment",
        mutation: false,
        query: `query PaperclipFindEvidenceComment($linearIssueId: String!, $after: String) {
  issue(id: $linearIssueId) {
    id
    identifier
    comments(first: 50, after: $after) {
      nodes { id body createdAt issue { id identifier } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
        variables: { linearIssueId, after },
      });
      if (!data.issue || (data.issue.id !== linearIssueId && data.issue.identifier !== linearIssueId)) {
        throw new LinearEvidenceTransportError("remote_conflict");
      }
      const comments = data.issue.comments;
      if (!comments || !Array.isArray(comments.nodes) || !comments.pageInfo) {
        throw new LinearEvidenceTransportError("remote_protocol_error");
      }
      for (const comment of comments.nodes) {
        if (typeof comment.body === "string" && comment.body.includes(marker)) {
          matches.push(commentReceipt(comment, linearIssueId));
          if (matches.length > 1) throw new LinearEvidenceTransportError("remote_conflict");
        }
      }
      if (comments.pageInfo.hasNextPage !== true) return matches[0] ?? null;
      const next = boundedOpaque(comments.pageInfo.endCursor);
      if (!next || next === after) throw new LinearEvidenceTransportError("remote_protocol_error");
      after = next;
    }
    // An incomplete marker scan cannot safely conclude that a create is unique.
    throw new LinearEvidenceTransportError("delivery_ambiguous");
  }

  async function createComment(input: { linearIssueId: string; body: string }) {
    const linearIssueId = requireIssueId(input.linearIssueId);
    if (typeof input.body !== "string" || !input.body || input.body.length > 100_000) {
      throw new LinearEvidenceTransportError("invalid_request");
    }
    if (containsCredentialMaterial(input.body)) {
      throw new LinearEvidenceTransportError("unsafe_comment_body");
    }
    const data = await request<{
      commentCreate?: { success?: unknown; comment?: { id?: unknown } | null } | null;
    }>({
      operation: "create_comment",
      mutation: true,
      query: `mutation PaperclipCreateEvidenceComment($linearIssueId: String!, $body: String!) {
  commentCreate(input: { issueId: $linearIssueId, body: $body }) {
    success
    comment { id }
  }
}`,
      variables: { linearIssueId, body: input.body },
    });
    const id = boundedOpaque(data.commentCreate?.comment?.id);
    if (data.commentCreate?.success !== true || !id) {
      throw new LinearEvidenceTransportError("remote_protocol_error");
    }
    return { id };
  }

  async function getComment(input: { linearIssueId: string; commentId: string }) {
    const linearIssueId = requireIssueId(input.linearIssueId);
    const commentId = requireCommentId(input.commentId);
    const data = await request<{ comment?: RemoteComment | null }>({
      operation: "get_comment",
      mutation: false,
      query: `query PaperclipGetEvidenceComment($commentId: String!) {
  comment(id: $commentId) { id body createdAt issue { id identifier } }
}`,
      variables: { commentId },
    });
    if (data.comment === null) return null;
    if (!data.comment) throw new LinearEvidenceTransportError("remote_protocol_error");
    return commentReceipt(data.comment, linearIssueId);
  }

  return Object.freeze({ findCommentByMarker, createComment, getComment });
}

export { LINEAR_GRAPHQL_ENDPOINT };
