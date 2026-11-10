import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type {
  ChatConversation,
  ChatEndpoint,
  ExternalChannelBindingSummary,
} from "../../../packages/shared/src/types/chat-channels.js";
import {
  selectedExternalCredential,
  type ProviderBinding,
} from "./external-fixtures.js";

export const slackCompanionFields = [
  "workspaceId",
  "channelId",
  "senderUserId",
  "botUserId",
  "appId",
  "registeredWebhookOrigin",
  "webhookRelayPort",
  "botTokenEnv",
  "senderTokenEnv",
  "signingSecretEnv",
  "configurationTokenEnv",
] as const;
export function slackFileDestination(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.slack.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new Error("Slack file transport escaped its official destination");
  return url;
}
const methods = {
  bot: new Set([
    "auth.test",
    "users.info",
    "bots.info",
    "conversations.info",
    "conversations.replies",
    "conversations.history",
    "chat.postMessage",
    "files.info",
  ]),
  sender: new Set([
    "auth.test",
    "chat.postMessage",
    "files.getUploadURLExternal",
    "files.completeUploadExternal",
  ]),
  configuration: new Set(["apps.manifest.export", "apps.manifest.update"]),
};
export function assertSlackFixture(binding: ProviderBinding) {
  const p = binding.prerequisites;
  for (const field of slackCompanionFields)
    if (!p[field])
      throw new Error(`Setup blocker: Slack ${field} reference is required`);
  for (const [field, pattern] of [
    ["workspaceId", /^T[A-Z0-9]+$/],
    ["channelId", /^[CG][A-Z0-9]+$/],
    ["senderUserId", /^[UW][A-Z0-9]+$/],
    ["botUserId", /^[UW][A-Z0-9]+$/],
    ["appId", /^A[A-Z0-9]+$/],
  ] as const) {
    if (!pattern.test(p[field]!) || !binding.resourceIds.includes(p[field]!))
      throw new Error(
        `Setup blocker: Slack ${field} is not an explicitly allowlisted disposable provider resource`,
      );
  }
  const origin = new URL(p.registeredWebhookOrigin!);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error(
      "Setup blocker: Slack requires an explicitly designated HTTPS webhook origin for this isolated attempt",
    );
  if (p.botUserId === p.senderUserId)
    throw new Error(
      "Setup blocker: canonical Slack sender must be the real linked human, not the app bot",
    );
}
export function assertSlackCall(
  binding: ProviderBinding,
  kind: keyof typeof methods,
  method: string,
  parameters: Record<string, unknown>,
) {
  assertSlackFixture(binding);
  if (!methods[kind].has(method))
    throw new Error(
      "Slack fixture method exceeds its finite provider contract",
    );
  const p = binding.prerequisites;
  if ("channel" in parameters && parameters.channel !== p.channelId)
    throw new Error("Slack fixture call escaped its allowed channel");
  if ("channel_id" in parameters && parameters.channel_id !== p.channelId)
    throw new Error("Slack fixture upload escaped its allowed channel");
  if ("app_id" in parameters && parameters.app_id !== p.appId)
    throw new Error("Slack fixture call escaped its allowed disposable app");
  if (
    (method === "apps.manifest.export" || method === "apps.manifest.update") &&
    parameters.app_id !== p.appId
  )
    throw new Error("Slack manifest operation requires the exact owned app");
  if (method === "chat.postMessage" && parameters.channel !== p.channelId)
    throw new Error("Slack canonical input requires the exact allowed channel");
}
/** Official Slack HTTP only. No fixture call occurs during import/calibration. */
export function slackProvider(
  ctx: ChatCatalogContext,
  binding: ProviderBinding,
  fetcher: typeof fetch = fetch,
) {
  assertSlackFixture(binding);
  let calls = 0;
  const receipts: Array<{ kind: string; method: string; ok: boolean }> = [];
  const ownedMessages: Array<{ kind: "sender" | "bot"; ts: string }> = [],
    ownedFiles: string[] = [],
    ownedBotFiles = new Set<string>(),
    ownedThreads = new Set<string>();
  async function invoke<T extends Record<string, unknown>>(
    kind: keyof typeof methods,
    method: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (++calls > 120)
      throw new Error(
        "Slack fixture exceeded its declared bounded provider calls",
      );
    const token = selectedExternalCredential(
      ctx,
      binding,
      kind === "bot"
        ? "botTokenEnv"
        : kind === "sender"
          ? "senderTokenEnv"
          : "configurationTokenEnv",
    );
    const response = await fetcher(`https://slack.com/api/${method}`, {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(parameters),
    });
    if (!response.ok) {
      receipts.push({ kind, method, ok: false });
      await response.body?.cancel();
      throw new Error(
        `Slack fixture ${method} returned HTTP ${response.status}; private response withheld`,
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Slack fixture response is missing");
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2 * 1024 * 1024)
          throw new Error(
            "Slack fixture response exceeds bounded metadata size",
          );
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    let result: T;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new Error(
        "Slack fixture returned invalid metadata; response withheld",
      );
    }
    receipts.push({ kind, method, ok: result.ok === true });
    if (result.ok !== true)
      throw new Error(
        `Slack fixture ${method} was not accepted; provider error details withheld`,
      );
    return result;
  }
  return {
    receipts,
    async uploadBrief(input: {
      filename: string;
      bytes: Buffer;
      query: string;
      threadId: string;
      signal: AbortSignal;
    }) {
      if (
        !ownedThreads.has(input.threadId) ||
        !/^[-a-zA-Z0-9_.]{1,100}$/.test(input.filename) ||
        !input.query ||
        input.bytes.length < 1 ||
        input.bytes.length > 12 * 1024 * 1024
      )
        throw new Error(
          "Slack brief upload exceeds its finite owned-thread contract",
        );
      const allocated = await invoke<{
        ok: true;
        file_id: string;
        upload_url: string;
      }>(
        "sender",
        "files.getUploadURLExternal",
        { filename: input.filename, length: input.bytes.length },
        input.signal,
      );
      if (!/^F[A-Z0-9]+$/.test(allocated.file_id))
        throw new Error("Slack returned an invalid allocated file identity");
      ownedFiles.push(allocated.file_id);
      ctx.input.privateSecrets?.push(allocated.upload_url);
      const destination = slackFileDestination(allocated.upload_url);
      if (++calls > 120)
        throw new Error(
          "Slack fixture exceeded its declared bounded provider calls",
        );
      const response = await fetcher(destination, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(30000)]),
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(input.bytes),
      });
      receipts.push({
        kind: "sender",
        method: "private-file-upload",
        ok: response.ok,
      });
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(
          "Slack private brief byte upload failed; response withheld",
        );
      await invoke(
        "sender",
        "files.completeUploadExternal",
        {
          files: [{ id: allocated.file_id, title: input.filename }],
          channel_id: binding.prerequisites.channelId,
          thread_ts: input.threadId,
          initial_comment: input.query,
        },
        input.signal,
      );
      return { id: allocated.file_id, byteSize: input.bytes.length };
    },
    async readThreadFile(
      threadId: string,
      fileId: string,
      author: "sender" | "bot",
      maximumBytes = 262144,
    ) {
      if (
        !ownedThreads.has(threadId) ||
        !/^F[A-Z0-9]+$/.test(fileId) ||
        !Number.isInteger(maximumBytes) ||
        maximumBytes < 1 ||
        maximumBytes > 12 * 1024 * 1024
      )
        throw new Error(
          "Slack file read exceeds its finite owned-thread contract",
        );
      const thread = await invoke<{
        ok: true;
        messages: Array<{
          ts: string;
          thread_ts?: string;
          user?: string;
          files?: Array<{ id: string }>;
        }>;
        has_more?: boolean;
      }>("bot", "conversations.replies", {
        channel: binding.prerequisites.channelId,
        ts: threadId,
        limit: 100,
      });
      const expectedAuthor =
        binding.prerequisites[author === "bot" ? "botUserId" : "senderUserId"];
      const messages = thread.messages?.filter(
        (row) =>
          row.thread_ts === threadId &&
          row.user === expectedAuthor &&
          row.files?.some((file) => file.id === fileId),
      );
      if (thread.has_more || messages?.length !== 1)
        throw new Error(
          "Slack file lacks one actual author-bound message in the owned thread",
        );
      const result = await invoke<{
        ok: true;
        file: {
          id: string;
          user: string;
          size: number;
          url_private_download: string;
          permalink: string;
          mimetype?: string;
          name?: string;
        };
      }>("bot", "files.info", { file: fileId });
      const file = result.file;
      if (
        file?.id !== fileId ||
        file.user !== expectedAuthor ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        file.size > maximumBytes
      )
        throw new Error(
          "Slack actual file metadata exceeds the expected author/size boundary",
        );
      const permalink = new URL(file.permalink);
      if (
        permalink.protocol !== "https:" ||
        !permalink.hostname.endsWith(".slack.com") ||
        permalink.username ||
        permalink.password ||
        permalink.port ||
        permalink.hash ||
        permalink.search ||
        !permalink.pathname.split("/").includes(fileId)
      )
        throw new Error("Slack file lacks a supported exact-file permalink");
      ctx.input.privateSecrets?.push(file.url_private_download);
      const destination = slackFileDestination(file.url_private_download);
      if (author === "bot") ownedBotFiles.add(fileId);
      if (++calls > 120)
        throw new Error(
          "Slack fixture exceeded its declared bounded provider calls",
        );
      const response = await fetcher(destination, {
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          authorization: `Bearer ${selectedExternalCredential(ctx, binding, "botTokenEnv")}`,
        },
      });
      receipts.push({
        kind: "bot",
        method: "private-file-download",
        ok: response.ok,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          "Slack actual file bytes unavailable; private response withheld",
        );
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Slack file response is empty");
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > maximumBytes || size > file.size)
            throw new Error("Slack file stream exceeds registered size");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      if (size !== file.size)
        throw new Error("Slack file stream differs from registered size");
      return {
        id: file.id,
        byteSize: size,
        contentType: file.mimetype ?? "",
        filename: file.name ?? "",
        messageId: messages[0]!.ts,
        permalink: permalink.href,
        bytes: Buffer.concat(chunks),
      };
    },
    async call<T extends Record<string, unknown>>(
      kind: keyof typeof methods,
      method: string,
      parameters: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<T> {
      assertSlackCall(binding, kind, method, parameters);
      const result = await invoke<T>(kind, method, parameters, signal);
      if (
        method === "chat.postMessage" &&
        kind !== "configuration" &&
        result.channel === binding.prerequisites.channelId &&
        typeof result.ts === "string"
      ) {
        ownedMessages.push({ kind, ts: result.ts });
        ownedThreads.add(
          typeof parameters.thread_ts === "string"
            ? parameters.thread_ts
            : result.ts,
        );
      }
      if (
        method === "files.completeUploadExternal" &&
        kind === "sender" &&
        Array.isArray(result.files)
      )
        for (const file of result.files) {
          if (file && typeof file.id === "string") ownedFiles.push(file.id);
        }
      return result;
    },
    /** No caller-supplied deletion IDs: only receipts from this client's actual
     * successful creation calls may be removed. Existing channel content is never
     * enumerated for cleanup or adopted as owned. */
    async cleanupOwned() {
      const failures: string[] = [];
      // Product-published replies are owned only through this client's genuinely
      // created roots. Read each exact thread, then delete only this app's bot
      // messages; never adopt another author's content as disposable.
      const threads = [...ownedThreads];
      ownedThreads.clear();
      for (const ts of threads)
        try {
          const thread = await invoke<{
            ok: true;
            messages: Array<{ ts: string; thread_ts?: string; user?: string }>;
            has_more?: boolean;
          }>("bot", "conversations.replies", {
            channel: binding.prerequisites.channelId,
            ts,
            limit: 100,
          });
          if (thread.has_more)
            throw new Error("Owned Slack cleanup exceeds finite thread bound");
          for (const message of thread.messages ?? [])
            if (
              message.user === binding.prerequisites.botUserId &&
              message.thread_ts === ts
            )
              await invoke("bot", "chat.delete", {
                channel: binding.prerequisites.channelId,
                ts: message.ts,
              });
        } catch {
          failures.push("owned-thread-replies");
        }
      for (const file of ownedBotFiles)
        try {
          await invoke("bot", "files.delete", { file });
        } catch {
          failures.push("owned-bot-file");
        }
      ownedBotFiles.clear();
      for (const file of [...new Set(ownedFiles.splice(0))].reverse())
        try {
          await invoke("sender", "files.delete", { file });
        } catch {
          failures.push("owned-file");
        }
      for (const message of ownedMessages.splice(0).reverse())
        try {
          await invoke(message.kind, "chat.delete", {
            channel: binding.prerequisites.channelId,
            ts: message.ts,
          });
        } catch {
          failures.push("owned-message");
        }
      if (failures.length)
        throw new Error(
          `Slack disposable cleanup incomplete: ${failures.length} owned resources could not be removed`,
        );
    },
  };
}

export interface SlackIngressReceipt {
  providerCalls: number;
  query: string;
  endpointId: string;
  conversationId: string;
  issueId: string;
  humanCommentId: string;
  linkedPaperclipUserId: string;
  provider: {
    workspaceId: string;
    channelId: string;
    threadId: string;
    canonicalMessageId: string;
    senderUserId: string;
  };
}
/** Source-qualified public DTO checks; externalThreadId is the SDK encoded key. */
export function slackIngressMatches(input: {
  receipt: SlackIngressReceipt;
  endpoint: ChatEndpoint;
  conversation: ChatConversation;
  binding: ExternalChannelBindingSummary;
  comment: {
    id: string;
    body: string;
    authorUserId: string | null;
    metadata?: { sourceChannel?: string };
  };
  canonicalQuery: string;
  companyId: string;
  agentId: string;
}) {
  const {
    receipt: r,
    endpoint: e,
    conversation: c,
    binding: b,
    comment,
  } = input;
  return (
    Number.isSafeInteger(r.providerCalls) &&
    r.providerCalls >= 1 &&
    r.providerCalls <= 20 &&
    r.query === input.canonicalQuery &&
    e.id === r.endpointId &&
    e.companyId === input.companyId &&
    e.assignedAgentId === input.agentId &&
    e.provider === "slack" &&
    e.providerAccountId === r.provider.workspaceId &&
    c.id === r.conversationId &&
    c.endpointId === e.id &&
    c.companyId === input.companyId &&
    c.issueId === r.issueId &&
    c.externalThreadId ===
      `slack:${r.provider.channelId}:${r.provider.threadId}` &&
    c.externalConversationId === `slack:${r.provider.channelId}` &&
    b.endpointId === e.id &&
    b.conversationId === c.id &&
    b.provider === "slack" &&
    b.assignedAgentLocked === true &&
    comment.id === r.humanCommentId &&
    comment.body === input.canonicalQuery &&
    comment.authorUserId === r.linkedPaperclipUserId &&
    comment.metadata?.sourceChannel === "slack" &&
    /^\d+\.\d{6}$/.test(r.provider.threadId) &&
    /^\d+\.\d{6}$/.test(r.provider.canonicalMessageId) &&
    r.provider.senderUserId !== e.botExternalId
  );
}
