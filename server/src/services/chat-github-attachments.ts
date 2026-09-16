import type { Attachment, Message } from "chat";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import {
  isAllowedContentType,
  MAX_ATTACHMENT_BYTES,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
} from "../attachment-types.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

const MAX_URL_LENGTH = 2048;
const DOWNLOAD_TIMEOUT_MS = 20_000;
export const GITHUB_ATTACHMENT_BATCH_TIMEOUT_MS = 60_000;
const MAX_ATTACHMENTS = 20;
const MAX_REFERENCES = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CDN_HOSTS = new Set([
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
  "github-production-repository-file-5c1aeb.s3.amazonaws.com",
]);
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
};

/** Provenance is the admitted comment, not ownership of GitHub's anonymized upload. */
export interface GitHubPublicAttachmentLocator {
  kind: "github_public_attachment";
  url: string;
  sourceThreadId: string;
  sourceMessageId: string;
  /** Old four-field descriptors remain anonymous-only. */
  version?: 2;
  sourceBodySha256?: string;
}

export interface GitHubAttachmentCommentRequest {
  url: string;
  accept: string;
}
export type GitHubAttachmentCommentResolver = (
  request: GitHubAttachmentCommentRequest,
  signal: AbortSignal,
) => Promise<unknown>;

export function isGitHubAttachmentCommentRequest(
  request: GitHubAttachmentCommentRequest,
): boolean {
  const match =
    /^https:\/\/api\.github\.com\/repos\/[a-z0-9][a-z0-9-]{0,38}\/([a-z0-9_.-]{1,100})\/(issues|pulls)\/comments\/[1-9][0-9]{0,24}$/i.exec(
      request.url,
    );
  return Boolean(
    match &&
    ![".", ".."].includes(match[1]!) &&
    request.accept ===
      (match[2] === "pulls"
        ? "application/vnd.github-commitcomment.full+json"
        : "application/vnd.github.full+json"),
  );
}

const handles = new WeakMap<Attachment, GitHubPublicAttachmentLocator>();
const limitOmissions = new WeakMap<Message, number>();

/** Informational only: this count cannot authorize or identify a downloadable file. */
export function githubAttachmentLimitOmissions(message: Message): number {
  return limitOmissions.get(message) ?? 0;
}

export function restoreGitHubAttachmentLimitOmissions(
  message: Message,
  value: unknown,
): void {
  limitOmissions.delete(message);
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_REFERENCES
  )
    limitOmissions.set(message, value);
}

const GITHUB_ATTACHMENT_DIAGNOSTIC_CODES = [
  "github_attachment_not_public",
  "github_attachment_invalid_response",
  "github_attachment_unsafe_redirect",
  "github_attachment_too_large",
  "github_attachment_empty",
  "github_attachment_unsupported_type",
  "github_attachment_download_failed",
  "github_attachment_source_mismatch",
  "github_attachment_canonical_authority_unavailable",
  "github_attachment_canonical_api_request_failed",
  "github_attachment_canonical_api_access_denied",
  "github_attachment_canonical_api_status_unexpected",
  "github_attachment_canonical_api_invalid_response",
  "github_attachment_canonical_api_too_large",
  "github_attachment_canonical_response_unavailable",
  "github_attachment_canonical_source_mismatch",
  "github_attachment_canonical_body_mismatch",
  "github_attachment_canonical_html_unavailable",
  "github_attachment_canonical_file_unsupported",
  "github_attachment_canonical_image_count_invalid",
  "github_attachment_canonical_target_denied",
  "github_attachment_canonical_mapping_ambiguous",
  "github_attachment_canonical_signed_anchor_only",
  "github_attachment_canonical_image_without_source_anchor",
  "github_attachment_canonical_anchor_missing",
] as const;
type GitHubAttachmentDiagnosticCode =
  (typeof GITHUB_ATTACHMENT_DIAGNOSTIC_CODES)[number];

/** Read no request/response data; SDK wrappers may retain a closed error as cause. */
export function githubAttachmentDiagnosticCode(
  error: unknown,
): GitHubAttachmentDiagnosticCode | null {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    if (
      GITHUB_ATTACHMENT_DIAGNOSTIC_CODES.includes(
        error.message as GitHubAttachmentDiagnosticCode,
      )
    )
      return error.message as GitHubAttachmentDiagnosticCode;
    error = error.cause;
  }
  return null;
}

export class GitHubAttachmentUnavailableError extends Error {
  constructor(readonly code: GitHubAttachmentDiagnosticCode) {
    // Closed codes only: URLs, signed redirects and provider response bodies never escape.
    super(code);
    this.name = "GitHubAttachmentUnavailableError";
  }
}

export function canonicalGitHubAttachmentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    if (
      !/^\/user-attachments\/(?:assets\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|files\/[1-9][0-9]*\/[^/]+)$/i.test(
        url.pathname,
      )
    )
      return null;
    if (
      /%(?:2f|5c|00|0[ad])/i.test(url.pathname) ||
      url.pathname.includes("\\")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function validThread(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^github:[a-z0-9_.-]+\/[a-z0-9_.-]+:(?:issue:)?[1-9][0-9]*(?::rc:[1-9][0-9]*)?$/i.test(
      value,
    )
  );
}

export function validateGitHubAttachmentLocator(
  value: unknown,
): GitHubPublicAttachmentLocator | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    ![
      "kind,sourceMessageId,sourceThreadId,url",
      "kind,sourceBodySha256,sourceMessageId,sourceThreadId,url,version",
    ].includes(Object.keys(row).sort().join(",")) ||
    (("version" in row || "sourceBodySha256" in row) &&
      (row.version !== 2 ||
        typeof row.sourceBodySha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.sourceBodySha256))) ||
    row.kind !== "github_public_attachment" ||
    !validThread(row.sourceThreadId) ||
    typeof row.sourceMessageId !== "string" ||
    !/^[1-9][0-9]{0,24}$/.test(row.sourceMessageId)
  )
    return null;
  const url = canonicalGitHubAttachmentUrl(row.url);
  return url
    ? {
        kind: "github_public_attachment",
        url,
        sourceThreadId: row.sourceThreadId,
        sourceMessageId: row.sourceMessageId,
        ...(row.version === 2
          ? {
              version: 2 as const,
              sourceBodySha256: row.sourceBodySha256 as string,
            }
          : {}),
      }
    : null;
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim()
    .slice(0, 200);
  return name && name !== "." && name !== ".." ? name : undefined;
}

export function githubAttachmentLocator(
  attachment: Attachment,
): GitHubPublicAttachmentLocator | null {
  return handles.get(attachment) ?? null;
}

export function rehydrateGitHubPublicAttachment(
  value: unknown,
  source: { threadId: string; messageId: string },
): Attachment | null {
  const locator = validateGitHubAttachmentLocator(value);
  if (
    !locator ||
    locator.sourceThreadId !== source.threadId ||
    locator.sourceMessageId !== source.messageId
  )
    return null;
  const url = new URL(locator.url);
  let name: string | undefined;
  if (url.pathname.startsWith("/user-attachments/files/")) {
    try {
      name = safeName(decodeURIComponent(url.pathname.split("/").at(-1)!));
    } catch {
      return null;
    }
  }
  const attachment: Attachment = {
    type: "file",
    name: name ?? `github-attachment-${url.pathname.split("/").at(-1)}`,
  };
  handles.set(attachment, locator);
  return attachment;
}

/** Parse references only; network I/O happens later, after Paperclip's admission fence. */
export function githubPublicAttachmentsFromMessage(
  message: Message,
): Attachment[] {
  limitOmissions.delete(message);
  const raw = message.raw as Record<string, unknown> | null;
  if (
    !raw ||
    !validThread(message.threadId) ||
    !/^[1-9][0-9]{0,24}$/.test(message.id)
  )
    return [];
  const comment = raw.comment as Record<string, unknown> | undefined;
  const repository = raw.repository as Record<string, unknown> | undefined;
  if (
    !comment ||
    !repository ||
    String(comment.id) !== message.id ||
    typeof comment.body !== "string" ||
    comment.body.length > 200_000
  )
    return [];
  const thread =
    /^github:([^:]+):(?:(issue):)?([1-9][0-9]*)(?::rc:([1-9][0-9]*))?$/i.exec(
      message.threadId,
    );
  if (
    !thread ||
    typeof repository.full_name !== "string" ||
    thread[1].toLowerCase() !== repository.full_name.toLowerCase() ||
    Number(thread[3]) !== raw.prNumber
  )
    return [];
  if (raw.type === "review_comment") {
    if (thread[2] || thread[4] !== String(comment.in_reply_to_id ?? comment.id))
      return [];
  } else if (
    raw.type !== "issue_comment" ||
    thread[4] ||
    Boolean(thread[2]) !== (raw.threadType === "issue")
  )
    return [];

  const urls = new Set<string>();
  const definitions = new Map<string, unknown>();
  const references: string[] = [];
  const stack: unknown[] = [message.formatted];
  let visited = 0;
  const sourceBody = comment.body;
  const add = (value: unknown) => {
    if (typeof value !== "string" || !sourceBody.includes(value)) return;
    const url = canonicalGitHubAttachmentUrl(value);
    if (url && urls.size < MAX_REFERENCES) urls.add(url);
  };
  while (stack.length && visited++ < 10_000) {
    const node = stack.pop() as Record<string, unknown> | null;
    if (!node || typeof node !== "object") continue;
    if (node.type === "link" || node.type === "image") add(node.url);
    if (node.type === "definition" && typeof node.identifier === "string")
      definitions.set(node.identifier.toLowerCase(), node.url);
    if (
      (node.type === "imageReference" || node.type === "linkReference") &&
      typeof node.identifier === "string"
    )
      references.push(node.identifier.toLowerCase());
    if (node.type === "html" && typeof node.value === "string") {
      const html = node.value.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
      for (const match of html.matchAll(
        /<img\b[^>]{0,8192}?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi,
      ))
        add(match[1] ?? match[2]);
    }
    if (Array.isArray(node.children))
      for (let index = node.children.length - 1; index >= 0; index--)
        stack.push(node.children[index]);
  }
  for (const id of references) add(definitions.get(id));
  restoreGitHubAttachmentLimitOmissions(
    message,
    Math.max(0, urls.size - MAX_ATTACHMENTS),
  );
  const sourceBodySha256 = createHash("sha256")
    .update(comment.body)
    .digest("hex");
  return [...urls]
    .slice(0, MAX_ATTACHMENTS)
    .map((url) =>
      rehydrateGitHubPublicAttachment(
        {
          kind: "github_public_attachment",
          url,
          sourceThreadId: message.threadId,
          sourceMessageId: message.id,
          version: 2,
          sourceBodySha256,
        },
        { threadId: message.threadId, messageId: message.id },
      )!,
    )
    .filter(Boolean);
}

function allowedRedirect(value: string, original: string): URL | null {
  try {
    const url = new URL(value, original);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 8192
    )
      return null;
    if (url.hostname === "github.com")
      return canonicalGitHubAttachmentUrl(url.href) ? url : null;
    if (!CDN_HOSTS.has(url.hostname) || url.pathname === "/") return null;
    return url;
  } catch {
    return null;
  }
}

/** Exact documented comment route; no caller-supplied API origin or query. */
export function githubAttachmentCommentRequest(
  attachment: Attachment,
): GitHubAttachmentCommentRequest | null {
  const locator = handles.get(attachment);
  if (locator?.version !== 2 || !locator.sourceBodySha256) return null;
  const thread =
    /^github:([^/:]+)\/([^:]+):(?:(issue):)?([1-9][0-9]*)(?::rc:([1-9][0-9]*))?$/i.exec(
      locator.sourceThreadId,
    );
  if (
    !thread ||
    !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(thread[1]!) ||
    !/^[a-z0-9_.-]{1,100}$/i.test(thread[2]!) ||
    [".", ".."].includes(thread[2]!)
  )
    return null;
  return {
    url: `https://api.github.com/repos/${thread[1]}/${thread[2]}/${thread[5] ? "pulls" : "issues"}/comments/${locator.sourceMessageId}`,
    accept: thread[5]
      ? "application/vnd.github-commitcomment.full+json"
      : "application/vnd.github.full+json",
  };
}

const MAX_COMMENT_RESPONSE_BYTES = 1_048_576;

/** Octokit's authenticated request may go only to this one fixed API route. */
export function githubAttachmentCommentFetch(
  expected: GitHubAttachmentCommentRequest,
  signal: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    if (
      !isGitHubAttachmentCommentRequest(expected) ||
      typeof input !== "string" ||
      input !== expected.url ||
      init?.method !== "GET"
    )
      throw new GitHubAttachmentUnavailableError(
        "github_attachment_source_mismatch",
      );
    signal.throwIfAborted();
    const headers = new Headers(init.headers);
    if (headers.get("accept") !== expected.accept || headers.has("cookie"))
      throw new GitHubAttachmentUnavailableError(
        "github_attachment_source_mismatch",
      );
    const response = await guardedRemoteHttpFetch(
      expected.url,
      {
        ...init,
        method: "GET",
        headers,
        credentials: "omit",
        redirect: "manual",
        signal,
      },
      {
        allowPrivateNetwork: false,
        connectTimeoutMs: 5000,
        responseTimeoutMs: DOWNLOAD_TIMEOUT_MS,
        error: () =>
          new GitHubAttachmentUnavailableError(
            "github_attachment_canonical_api_request_failed",
          ),
      },
    );
    if (
      response.status !== 200 ||
      !response.body ||
      !/^application\/json(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      Number(response.headers.get("content-length") ?? 0) >
        MAX_COMMENT_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new GitHubAttachmentUnavailableError(
        [401, 403, 404].includes(response.status)
          ? "github_attachment_canonical_api_access_denied"
          : response.status !== 200
            ? "github_attachment_canonical_api_status_unexpected"
            : Number(response.headers.get("content-length") ?? 0) >
                MAX_COMMENT_RESPONSE_BYTES
              ? "github_attachment_canonical_api_too_large"
              : "github_attachment_canonical_api_invalid_response",
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_COMMENT_RESPONSE_BYTES)
          throw new GitHubAttachmentUnavailableError(
            "github_attachment_canonical_api_too_large",
          );
        chunks.push(next.value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
    }
    return new Response(Buffer.concat(chunks), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * The authenticated rendering is evidence only for this exact unchanged source.
 * We support GitHub's image anchor mapping, not arbitrary HTML URL extraction.
 * No signed URL is returned to the model or added to durable descriptors.
 */
export function resolveGitHubCommentAttachmentTarget(
  attachment: Attachment,
  value: unknown,
): URL | null {
  try {
    return resolveCanonicalAttachmentTargetOrThrow(attachment, value);
  } catch (error) {
    if (error instanceof GitHubAttachmentUnavailableError) return null;
    throw error;
  }
}

function resolveCanonicalAttachmentTargetOrThrow(
  attachment: Attachment,
  value: unknown,
): URL {
  const locator = handles.get(attachment);
  const request = githubAttachmentCommentRequest(attachment);
  if (
    !locator ||
    !request ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_canonical_response_unavailable",
    );
  const row = value as Record<string, unknown>;
  const thread =
    /^github:([^:]+):(?:(issue):)?([1-9][0-9]*)(?::rc:([1-9][0-9]*))?$/i.exec(
      locator.sourceThreadId,
    )!;
  if (
    String(row.id) !== locator.sourceMessageId ||
    typeof row.url !== "string" ||
    row.url.toLowerCase() !== request.url.toLowerCase()
  )
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_canonical_source_mismatch",
    );
  if (
    typeof row.body !== "string" ||
    row.body.length > 200_000 ||
    createHash("sha256").update(row.body).digest("hex") !==
      locator.sourceBodySha256
  )
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_canonical_body_mismatch",
    );
  if (typeof row.body_html !== "string" || row.body_html.length > 600_000)
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_canonical_html_unavailable",
    );
  if (thread[4]) {
    if (
      row.pull_request_url !==
        `https://api.github.com/repos/${thread[1]}/pulls/${thread[3]}` ||
      String(row.in_reply_to_id ?? row.id) !== thread[4]
    )
      throw new GitHubAttachmentUnavailableError(
        "github_attachment_canonical_source_mismatch",
      );
  } else if (
    row.issue_url !==
    `https://api.github.com/repos/${thread[1]}/issues/${thread[3]}`
  )
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_canonical_source_mismatch",
    );
  const assetId = /\/assets\/([a-f0-9-]+)$/i.exec(locator.url)?.[1];
  // Generic private files have no documented signed-download representation.
  if (!assetId)
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_canonical_file_unsupported",
    );
  const sourceBody = row.body;
  const imagePath = new RegExp(
    `^/[1-9][0-9]*/[1-9][0-9]*-${assetId}\\.(?:png|jpe?g|gif|webp)$`,
    "i",
  );
  const sameAssetImage = (src: string): URL | null => {
    const target = allowedRedirect(src, locator.url);
    return target?.hostname === "private-user-images.githubusercontent.com" &&
      imagePath.test(target.pathname)
      ? target
      : null;
  };
  const signedImage = (src: string): URL | null => {
    const target = sameAssetImage(src);
    return target &&
      [...target.searchParams.keys()].join(",") === "jwt" &&
      /^[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(
        target.searchParams.get("jwt") ?? "",
      ) &&
      !sourceBody.includes(src)
      ? target
      : null;
  };
  const fragment = JSDOM.fragment(row.body_html);
  const candidates: URL[] = [];
  for (const anchor of fragment.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href")!;
    const images = anchor.querySelectorAll("img[src]");
    if (
      href !== locator.url &&
      !sameAssetImage(href) &&
      ![...images].some((image) => sameAssetImage(image.getAttribute("src")!))
    )
      continue;
    if (images.length !== 1)
      throw new GitHubAttachmentUnavailableError(
        "github_attachment_canonical_image_count_invalid",
      );
    const src = images[0]!.getAttribute("src")!;
    const target = signedImage(src);
    // The second form was observed in the exact App-rendered live comment.
    // Both the original-anchor and signed-anchor forms enter one candidate set
    // so duplicated or mixed renderings cannot silently choose a target.
    if (
      !target ||
      (href !== locator.url && (href !== src || !signedImage(href)))
    )
      throw new GitHubAttachmentUnavailableError(
        "github_attachment_canonical_target_denied",
      );
    candidates.push(target);
  }
  const sameAssetImages = [...fragment.querySelectorAll("img[src]")].filter(
    (image) =>
      image.getAttribute("src") === locator.url ||
      sameAssetImage(image.getAttribute("src")!),
  );
  if (candidates.length > 1 || sameAssetImages.length > 1)
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_canonical_mapping_ambiguous",
    );
  if (candidates.length === 1 && sameAssetImages.length === 1)
    return candidates[0]!;
  if (
    [...fragment.querySelectorAll("img[src]")].some((image) =>
      signedImage(image.getAttribute("src")!),
    )
  )
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_canonical_image_without_source_anchor",
    );
  throw new GitHubAttachmentUnavailableError(
    "github_attachment_canonical_anchor_missing",
  );
}

function imageSignatureMatches(body: Buffer, mime: string): boolean {
  if (mime === "image/png")
    return body
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg" || mime === "image/jpg")
    return body[0] === 255 && body[1] === 216 && body[2] === 255;
  if (mime === "image/gif")
    return /^(GIF87a|GIF89a)$/.test(body.subarray(0, 6).toString("ascii"));
  if (mime === "image/webp")
    return (
      body.subarray(0, 4).toString("ascii") === "RIFF" &&
      body.subarray(8, 12).toString("ascii") === "WEBP"
    );
  return !mime.startsWith("image/");
}

/** Download hosts never receive provider credentials, including after canonical resolution. */
export async function prepareGitHubPublicAttachment(
  attachment: Attachment,
  batchSignal?: AbortSignal,
  resolveComment?: GitHubAttachmentCommentResolver,
): Promise<Attachment> {
  const locator = handles.get(attachment);
  if (!locator)
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_source_mismatch",
    );
  const downloadSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = batchSignal
    ? AbortSignal.any([downloadSignal, batchSignal])
    : downloadSignal;
  try {
    let url = new URL(locator.url);
    let resolvedCanonicalComment = false;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const response = await guardedRemoteHttpFetch(
        url,
        {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          signal,
          headers: { accept: "*/*", "user-agent": "Paperclip/ChatAttachments" },
        },
        {
          allowPrivateNetwork: false,
          connectTimeoutMs: 5000,
          responseTimeoutMs: DOWNLOAD_TIMEOUT_MS,
          error: () =>
            new GitHubAttachmentUnavailableError(
              "github_attachment_download_failed",
            ),
        },
      );
      if (REDIRECT_STATUSES.has(response.status)) {
        const target = allowedRedirect(
          response.headers.get("location") ?? "",
          url.href,
        );
        await response.body?.cancel();
        if (!target || redirects === 3)
          throw new GitHubAttachmentUnavailableError(
            "github_attachment_unsafe_redirect",
          );
        url = target;
        continue;
      }
      const rejectResponse = async (
        code: GitHubAttachmentUnavailableError["code"],
      ): Promise<never> => {
        await response.body?.cancel();
        throw new GitHubAttachmentUnavailableError(code);
      };
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        const commentRequest = githubAttachmentCommentRequest(attachment);
        if (!resolvedCanonicalComment && resolveComment && commentRequest) {
          await response.body?.cancel();
          resolvedCanonicalComment = true;
          signal.throwIfAborted();
          const canonical = await resolveComment(commentRequest, signal);
          signal.throwIfAborted();
          const target = resolveCanonicalAttachmentTargetOrThrow(
            attachment,
            canonical,
          );
          url = target;
          continue;
        }
        return await rejectResponse("github_attachment_not_public");
      }
      if (response.status !== 200 || !response.body)
        return await rejectResponse("github_attachment_invalid_response");
      const mimeType = normalizeUploadAttachmentContentType({
        contentType: normalizeContentType(response.headers.get("content-type")),
        originalFilename: attachment.name,
        isAllowedContentType,
      });
      // A login/error document is never a successfully downloaded attachment.
      if (mimeType === "text/html" || !isAllowedContentType(mimeType))
        return await rejectResponse("github_attachment_unsupported_type");
      const declared = response.headers.get("content-length");
      if (
        declared &&
        (!/^\d+$/.test(declared) || Number(declared) > MAX_ATTACHMENT_BYTES)
      )
        return await rejectResponse("github_attachment_too_large");
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_ATTACHMENT_BYTES)
            throw new GitHubAttachmentUnavailableError(
              "github_attachment_too_large",
            );
          chunks.push(Buffer.from(next.value));
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => undefined);
      }
      if (!size)
        throw new GitHubAttachmentUnavailableError("github_attachment_empty");
      // Content-Length describes compressed bytes when Content-Encoding is present.
      if (
        declared &&
        !response.headers.get("content-encoding") &&
        size !== Number(declared)
      )
        throw new GitHubAttachmentUnavailableError(
          "github_attachment_invalid_response",
        );
      const body = Buffer.concat(chunks, size);
      if (
        !imageSignatureMatches(body, mimeType) ||
        /^\s*(?:<!doctype\s+html|<html\b)/i.test(
          body.subarray(0, 512).toString("utf8"),
        )
      )
        throw new GitHubAttachmentUnavailableError(
          "github_attachment_invalid_response",
        );
      const name = attachment.name?.startsWith("github-attachment-")
        ? `${attachment.name}${MIME_EXTENSIONS[mimeType] ?? ""}`
        : attachment.name;
      return {
        type: mimeType.startsWith("image/")
          ? "image"
          : mimeType.startsWith("audio/")
            ? "audio"
            : mimeType.startsWith("video/")
              ? "video"
              : "file",
        name,
        mimeType,
        size,
        fetchData: async () => body,
      };
    }
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_unsafe_redirect",
    );
  } catch (error) {
    if (error instanceof GitHubAttachmentUnavailableError) throw error;
    throw new GitHubAttachmentUnavailableError(
      "github_attachment_download_failed",
    );
  }
}
