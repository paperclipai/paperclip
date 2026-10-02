import { createHash } from "node:crypto";

const GITHUB_APP_WEBHOOK_CONFIG_URL = "https://api.github.com/app/hook/config";
const MAX_CONFIG_RESPONSE_BYTES = 32_768;

/** Decimal strings, including for identifiers beyond Number.MAX_SAFE_INTEGER. */
export type GitHubWebhookDeliveryId = string;
export interface GitHubAppWebhookDelivery {
  id: GitHubWebhookDeliveryId;
  guid: string;
  deliveredAt: string;
  redelivery: boolean;
  statusCode: number | null;
  event: string;
  action: string | null;
  installationId: string | null;
  repositoryId: string | null;
  throttledAt: string | null;
}

export interface GitHubRecoveryComment {
  id: string;
  createdAt: string;
  updatedAt: string;
  userId: string;
  userType: "User" | "Bot" | "Organization" | "Mannequin";
  bodySha256: string;
  issueNumber: string | null;
  pullRequestNumber: string | null;
}

export interface GitHubAppWebhookDeliveryDetail extends GitHubAppWebhookDelivery {
  url: string;
  payload: {
    action: string | null;
    installationId: string | null;
    repositoryId: string | null;
    repositoryFullName: string | null;
    issueId: string | null;
    issueNumber: string | null;
    pullRequestId: string | null;
    pullRequestNumber: string | null;
    comment: GitHubRecoveryComment | null;
    senderId: string | null;
  };
}

export interface GitHubAppWebhookConfig {
  url: string;
  contentType: "json" | "form";
  insecureSsl: "0" | "1";
}

type RecoveryErrorCode =
  | "github_webhook_recovery_invalid_input"
  | "github_webhook_recovery_transport"
  | "github_webhook_recovery_http"
  | "github_webhook_recovery_invalid_response";

/** Closed errors only: never retain a fetch cause, response, token, or payload. */
export class GitHubWebhookRecoveryError extends Error {
  constructor(
    readonly code: RecoveryErrorCode,
    readonly statusCode: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly requestMayHaveBeenAccepted = false,
  ) {
    super(
      `GitHub webhook recovery could not be confirmed (${code}${statusCode === null ? "" : `; HTTP ${statusCode}`}).`,
    );
    this.name = "GitHubWebhookRecoveryError";
  }
}

type AppRequest = { fetch: typeof globalThis.fetch; appToken: string };
const GITHUB_DELIVERIES_URL = "https://api.github.com/app/hook/deliveries";
const MAX_DELIVERIES_BYTES = 262_144;
const MAX_DETAIL_BYTES = 1_048_576;
const MAX_RETRY_DELAY_MS = 86_400_000;
const ID_KEYS = new Set([
  "id",
  "installation_id",
  "repository_id",
  "number",
  "in_reply_to_id",
]);

function invalidResponse(): never {
  throw new GitHubWebhookRecoveryError(
    "github_webhook_recovery_invalid_response",
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidResponse();
  return value as Record<string, unknown>;
}

function decimalId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    (value.length === 20 && value > "18446744073709551615")
  )
    invalidResponse();
  return value;
}

function inputId(value: unknown): string {
  try {
    return decimalId(value);
  } catch {
    throw new GitHubWebhookRecoveryError(
      "github_webhook_recovery_invalid_input",
    );
  }
}

function optionalId(value: unknown): string | null {
  return value === undefined || value === null ? null : decimalId(value);
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalidResponse();
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`,
  );
  if (new Date(value).toISOString() !== normalized) invalidResponse();
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  return value === undefined || value === null ? null : timestamp(value);
}

function eventName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z_]{0,63}$/.test(value))
    invalidResponse();
  return value;
}

function optionalEventName(value: unknown): string | null {
  return value === undefined || value === null ? null : eventName(value);
}

function callbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) invalidResponse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidResponse();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\s\\]/.test(value)
  )
    invalidResponse();
  return value;
}

function repositoryName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) ||
    value.endsWith("/.") ||
    value.endsWith("/..")
  )
    invalidResponse();
  return value;
}

function cursorValue(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/_=:-]{1,512}$/.test(value))
    invalidResponse();
  return value;
}

function nextCursor(link: string | null): string | null {
  if (!link) return null;
  if (link.length > 8192) invalidResponse();
  let next: string | null = null;
  for (const entry of link.split(",")) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel="(next|prev|first|last)"\s*$/.exec(
      entry,
    );
    if (!match) invalidResponse();
    let url: URL;
    try {
      url = new URL(match[1]!);
    } catch {
      return invalidResponse();
    }
    if (
      url.origin !== "https://api.github.com" ||
      url.pathname !== "/app/hook/deliveries" ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some(
        (key) => key !== "per_page" && key !== "cursor",
      ) ||
      url.searchParams.getAll("cursor").length !== 1 ||
      url.searchParams.getAll("per_page").length > 1 ||
      (url.searchParams.has("per_page") &&
        url.searchParams.get("per_page") !== "100")
    )
      invalidResponse();
    const cursor = cursorValue(url.searchParams.get("cursor"));
    if (match[2] === "next") {
      if (next !== null) invalidResponse();
      next = cursor;
    }
  }
  return next;
}

function retryDelay(headers: Headers): number | null {
  const retry = headers.get("retry-after");
  let delay: number | null = null;
  if (retry && /^\d{1,10}$/.test(retry)) delay = Number(retry) * 1000;
  else if (
    retry &&
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      retry,
    ) &&
    Number.isFinite(Date.parse(retry))
  ) {
    delay = Math.max(0, Date.parse(retry) - Date.now());
  }
  const reset = headers.get("x-ratelimit-reset");
  if (
    headers.get("x-ratelimit-remaining") === "0" &&
    reset &&
    /^\d{1,12}$/.test(reset)
  ) {
    delay = Math.max(delay ?? 0, Number(reset) * 1000 - Date.now(), 0);
  }
  return delay === null ? null : Math.min(MAX_RETRY_DELAY_MS, delay);
}

async function readLosslessJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d{1,12}$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    invalidResponse();
  }
  const reader = response.body?.getReader();
  if (!reader) invalidResponse();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) invalidResponse();
      chunks.push(chunk.value);
    }
    // Node >=24.11 (the repository's supported runtime) supplies context.source.
    // Never recover an unsafe ID from the already rounded numeric value.
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      (key: string, value: unknown, context?: { source?: string }) => {
        if (ID_KEYS.has(key) && typeof value === "number") {
          return decimalId(context?.source);
        }
        return value;
      },
    );
  } catch {
    await reader.cancel().catch(() => undefined);
    return invalidResponse();
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function recoveryRequest<T>(input: {
  fetch: typeof globalThis.fetch;
  token: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: string;
  expectedStatus?: number;
  timeoutMs?: number;
  uncertainMutation?: boolean;
  project: (response: Response, signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (
    !input.token ||
    input.token.length > 8192 ||
    /[^\x21-\x7e]/.test(input.token)
  ) {
    throw new GitHubWebhookRecoveryError(
      "github_webhook_recovery_invalid_input",
    );
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new GitHubWebhookRecoveryError(
          "github_webhook_recovery_transport",
          null,
          null,
          input.uncertainMutation === true,
        ),
      );
    }, input.timeoutMs ?? 25_000);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await input.fetch(
          `https://api.github.com${input.path}`,
          {
            method: input.method ?? "GET",
            redirect: "error",
            signal: controller.signal,
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${input.token}`,
              "x-github-api-version": "2022-11-28",
              ...(input.body ? { "content-type": "application/json" } : {}),
            },
            ...(input.body ? { body: input.body } : {}),
          },
        );
        if (controller.signal.aborted) {
          await response.body?.cancel().catch(() => undefined);
          throw new GitHubWebhookRecoveryError(
            "github_webhook_recovery_transport",
            null,
            null,
            input.uncertainMutation === true,
          );
        }
        if (response.status !== (input.expectedStatus ?? 200)) {
          await response.body?.cancel().catch(() => undefined);
          throw new GitHubWebhookRecoveryError(
            "github_webhook_recovery_http",
            response.status,
            retryDelay(response.headers),
            input.uncertainMutation === true &&
              (response.status >= 500 || response.status === 408),
          );
        }
        return input.project(response, controller.signal);
      })(),
    ]);
  } catch (error) {
    if (error instanceof GitHubWebhookRecoveryError) throw error;
    throw new GitHubWebhookRecoveryError(
      "github_webhook_recovery_transport",
      null,
      null,
      input.uncertainMutation === true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function deliveryMetadata(value: unknown): GitHubAppWebhookDelivery {
  const row = record(value);
  if (
    typeof row.guid !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      row.guid,
    ) ||
    typeof row.redelivery !== "boolean" ||
    (row.status_code !== null &&
      (!Number.isInteger(row.status_code) ||
        typeof row.status_code !== "number" ||
        (row.status_code !== 0 &&
          (row.status_code < 100 || row.status_code > 599))))
  )
    invalidResponse();
  return {
    id: decimalId(row.id),
    guid: row.guid.toLowerCase(),
    deliveredAt: timestamp(row.delivered_at),
    redelivery: row.redelivery,
    statusCode: row.status_code as number | null,
    event: eventName(row.event),
    action: optionalEventName(row.action),
    installationId: optionalId(row.installation_id),
    repositoryId: optionalId(row.repository_id),
    throttledAt: optionalTimestamp(row.throttled_at),
  };
}

function commentNumber(
  value: unknown,
  fullName: string,
  kind: "issues" | "pulls",
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 2048) invalidResponse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidResponse();
  }
  const prefix = `/repos/${fullName}/${kind}/`;
  if (
    url.origin !== "https://api.github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())
  )
    invalidResponse();
  return decimalId(url.pathname.slice(prefix.length));
}

function commentMetadata(
  value: unknown,
  fullName: string,
): GitHubRecoveryComment {
  const row = record(value);
  const user = record(row.user);
  if (
    typeof row.body !== "string" ||
    typeof user.type !== "string" ||
    !["User", "Bot", "Organization", "Mannequin"].includes(user.type)
  )
    invalidResponse();
  return {
    id: decimalId(row.id),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    userId: decimalId(user.id),
    userType: user.type as GitHubRecoveryComment["userType"],
    bodySha256: createHash("sha256").update(row.body).digest("hex"),
    issueNumber: commentNumber(row.issue_url, fullName, "issues"),
    pullRequestNumber: commentNumber(row.pull_request_url, fullName, "pulls"),
  };
}

/** App JWT only. See https://docs.github.com/en/rest/apps/webhooks. No status
 * filter: successful sibling attempts must remain visible to the recovery gate. */
export async function listGitHubAppWebhookDeliveries(
  input: AppRequest & { cursor?: string | null },
): Promise<{
  deliveries: GitHubAppWebhookDelivery[];
  nextCursor: string | null;
}> {
  let cursor: string | null = null;
  if (input.cursor !== undefined && input.cursor !== null) {
    try {
      cursor = cursorValue(input.cursor);
    } catch {
      throw new GitHubWebhookRecoveryError(
        "github_webhook_recovery_invalid_input",
      );
    }
  }
  const url = new URL(GITHUB_DELIVERIES_URL);
  url.searchParams.set("per_page", "100");
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  return recoveryRequest({
    ...input,
    token: input.appToken,
    path: `${url.pathname}${url.search}`,
    project: async (response, signal) => {
      const parsed = await readLosslessJson(
        response,
        MAX_DELIVERIES_BYTES,
        signal,
      );
      if (!Array.isArray(parsed) || parsed.length > 100) invalidResponse();
      return {
        deliveries: parsed.map(deliveryMetadata),
        nextCursor: nextCursor(response.headers.get("link")),
      };
    },
  });
}

export async function readGitHubAppWebhookConfig(
  input: AppRequest,
): Promise<GitHubAppWebhookConfig> {
  return recoveryRequest({
    ...input,
    token: input.appToken,
    path: "/app/hook/config",
    project: async (response, signal) => {
      const config = record(
        await readLosslessJson(response, MAX_CONFIG_RESPONSE_BYTES, signal),
      );
      if (
        (config.content_type !== "json" && config.content_type !== "form") ||
        !["0", "1", 0, 1].includes(config.insecure_ssl as string | number)
      )
        invalidResponse();
      return {
        url: callbackUrl(config.url),
        contentType: config.content_type,
        insecureSsl: String(config.insecure_ssl) as "0" | "1",
      };
    },
  });
}

export async function getGitHubAppWebhookDelivery(
  input: AppRequest & { deliveryId: string },
): Promise<GitHubAppWebhookDeliveryDetail> {
  const id = inputId(input.deliveryId);
  return recoveryRequest({
    ...input,
    token: input.appToken,
    path: `/app/hook/deliveries/${id}`,
    project: async (response, signal) => {
      const row = record(
        await readLosslessJson(response, MAX_DETAIL_BYTES, signal),
      );
      const metadata = deliveryMetadata(row);
      if (metadata.id !== id) invalidResponse();
      const payload = record(record(row.request).payload);
      const nestedId = (key: string) =>
        payload[key] == null ? null : optionalId(record(payload[key]).id);
      const nestedNumber = (key: string) =>
        payload[key] == null ? null : optionalId(record(payload[key]).number);
      const fullName =
        payload.repository == null
          ? null
          : repositoryName(record(payload.repository).full_name);
      if (payload.comment != null && fullName === null) invalidResponse();
      return {
        ...metadata,
        url: callbackUrl(row.url),
        payload: {
          action: optionalEventName(payload.action),
          installationId: nestedId("installation"),
          repositoryId: nestedId("repository"),
          repositoryFullName: fullName,
          issueId: nestedId("issue"),
          issueNumber: nestedNumber("issue"),
          pullRequestId: nestedId("pull_request"),
          pullRequestNumber: nestedNumber("pull_request"),
          comment:
            payload.comment == null
              ? null
              : commentMetadata(payload.comment, fullName!),
          senderId: nestedId("sender"),
        },
      };
    },
  });
}

/** Never retry here: a transport error can follow an accepted remote mutation. */
export async function requestGitHubAppWebhookRedelivery(
  input: AppRequest & { deliveryId: string },
): Promise<{ accepted: true }> {
  const id = inputId(input.deliveryId);
  return recoveryRequest({
    ...input,
    token: input.appToken,
    path: `/app/hook/deliveries/${id}/attempts`,
    method: "POST",
    expectedStatus: 202,
    uncertainMutation: true,
    project: async (response) => {
      await response.body?.cancel().catch(() => undefined);
      return { accepted: true };
    },
  });
}

/** Mint a read-only, single-repository token, inspect one exact comment, then
 * revoke. See the official Apps token and Issues/Pulls comment REST endpoints.
 * No installation token or comment text crosses this helper's return boundary. */
export async function getGitHubRecoveryComment(
  input: AppRequest & {
    installationId: string;
    repositoryFullName: string;
    event: "issue_comment" | "pull_request_review_comment";
    commentId: string;
  },
): Promise<GitHubRecoveryComment> {
  const id = inputId(input.commentId);
  const installationId = inputId(input.installationId);
  let fullName: string;
  try {
    fullName = repositoryName(input.repositoryFullName);
  } catch {
    throw new GitHubWebhookRecoveryError(
      "github_webhook_recovery_invalid_input",
    );
  }
  if (
    input.event !== "issue_comment" &&
    input.event !== "pull_request_review_comment"
  ) {
    throw new GitHubWebhookRecoveryError(
      "github_webhook_recovery_invalid_input",
    );
  }
  const token = await recoveryRequest({
    ...input,
    token: input.appToken,
    path: `/app/installations/${installationId}/access_tokens`,
    method: "POST",
    expectedStatus: 201,
    timeoutMs: 10_000,
    body: JSON.stringify({
      repositories: [fullName.split("/")[1]],
      permissions: { issues: "read", pull_requests: "read" },
    }),
    project: async (response, signal) => {
      const row = record(await readLosslessJson(response, 16_384, signal));
      if (
        typeof row.token !== "string" ||
        !/^[\x21-\x7e]{1,8192}$/.test(row.token)
      )
        invalidResponse();
      return row.token;
    },
  });
  try {
    const kind = input.event === "issue_comment" ? "issues" : "pulls";
    return await recoveryRequest({
      ...input,
      token,
      path: `/repos/${fullName}/${kind}/comments/${id}`,
      timeoutMs: 10_000,
      project: async (response, signal) => {
        const comment = commentMetadata(
          await readLosslessJson(response, MAX_DETAIL_BYTES, signal),
          fullName,
        );
        if (
          comment.id !== id ||
          (kind === "issues"
            ? comment.issueNumber
            : comment.pullRequestNumber) === null
        )
          invalidResponse();
        return comment;
      },
    });
  } finally {
    await recoveryRequest({
      ...input,
      token,
      path: "/installation/token",
      method: "DELETE",
      expectedStatus: 204,
      timeoutMs: 2_000,
      project: async (response) => {
        await response.body?.cancel().catch(() => undefined);
      },
    }).catch(() => undefined);
  }
}

/**
 * Reconcile an already-owned App's callback, not its installation or permissions.
 * A successful PATCH is configuration evidence only, never a signed ping or a
 * successful chat round trip. See https://docs.github.com/en/rest/apps/webhooks.
 */
export async function resyncGitHubAppWebhook(input: {
  fetch: typeof globalThis.fetch;
  appToken: string;
  webhookUrl: string;
  webhookSecret: string;
}): Promise<void> {
  const webhookUrl = new URL(input.webhookUrl);
  if (
    webhookUrl.protocol !== "https:" ||
    webhookUrl.username ||
    webhookUrl.password ||
    webhookUrl.search ||
    webhookUrl.hash ||
    !input.webhookSecret
  ) {
    throw new Error("GitHub webhook configuration is incomplete");
  }

  let response: Response;
  try {
    response = await input.fetch(GITHUB_APP_WEBHOOK_CONFIG_URL, {
      method: "PATCH",
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.appToken}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        url: input.webhookUrl,
        content_type: "json",
        insecure_ssl: "0",
        secret: input.webhookSecret,
      }),
    });
  } catch {
    // A fetch error can embed request bodies, headers, or a proxy response.
    // Keep it out of endpoint health, the audit log, and the board response.
    throw new Error(
      "GitHub webhook configuration could not be confirmed. Reconnect to retry; repository access was not changed.",
    );
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `GitHub could not update this App's webhook (HTTP ${response.status}). Check that the App is active and reconnect.`,
    );
  }

  // GitHub can echo a masked secret and provider error bodies are untrusted.
  // Read a bounded response and return no provider body to callers or logs.
  let config: Record<string, unknown>;
  const reader = response.body?.getReader();
  try {
    if (!reader) throw new Error("Missing webhook configuration response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CONFIG_RESPONSE_BYTES) {
        throw new Error("Oversized webhook configuration response");
      }
      chunks.push(chunk.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid webhook configuration response");
    }
    config = parsed as Record<string, unknown>;
  } catch {
    await reader?.cancel().catch(() => undefined);
    throw new Error(
      "GitHub returned an unreadable webhook configuration. Reconnect to confirm the callback settings.",
    );
  } finally {
    reader?.releaseLock();
  }
  if (
    config.url !== input.webhookUrl ||
    config.content_type !== "json" ||
    (config.insecure_ssl !== "0" && config.insecure_ssl !== 0)
  ) {
    throw new Error(
      "GitHub did not confirm the expected secure Paperclip webhook. Reconnect to retry.",
    );
  }
}
