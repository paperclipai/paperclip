import { describe, expect, it } from "vitest";
import type {
  ChatConversation,
  ChatEndpoint,
  ExternalChannelBindingSummary,
} from "../../../packages/shared/src/types/chat-channels.js";
import {
  assertSlackCall,
  assertSlackFixture,
  slackIngressMatches,
  slackFileDestination,
  type SlackIngressReceipt,
} from "./external-slack-provider.js";
function binding() {
  return {
    disposable: true as const,
    resourceIds: ["TWORKSPACE", "CCHANNEL", "USENDER", "UBOT", "AAPP"],
    credentialEnv: [
      "PAPERCLIP_CHAT_EVAL_SLACK_BOT",
      "PAPERCLIP_CHAT_EVAL_SLACK_SENDER",
      "PAPERCLIP_CHAT_EVAL_SLACK_SIGNING",
      "PAPERCLIP_CHAT_EVAL_SLACK_CONFIG",
    ],
    prerequisites: {
      workspaceId: "TWORKSPACE",
      channelId: "CCHANNEL",
      senderUserId: "USENDER",
      botUserId: "UBOT",
      appId: "AAPP",
      registeredWebhookOrigin: "https://isolated.example.test",
      webhookRelayPort: "3399",
      botTokenEnv: "PAPERCLIP_CHAT_EVAL_SLACK_BOT",
      senderTokenEnv: "PAPERCLIP_CHAT_EVAL_SLACK_SENDER",
      signingSecretEnv: "PAPERCLIP_CHAT_EVAL_SLACK_SIGNING",
      configurationTokenEnv: "PAPERCLIP_CHAT_EVAL_SLACK_CONFIG",
    },
  };
}
function ingress() {
  const receipt: SlackIngressReceipt = {
    providerCalls: 1,
    query: "Exact canonical query.",
    endpointId: "endpoint",
    conversationId: "conversation",
    issueId: "issue",
    humanCommentId: "comment",
    linkedPaperclipUserId: "human",
    provider: {
      workspaceId: "TWORKSPACE",
      channelId: "CCHANNEL",
      threadId: "1793050000.123456",
      canonicalMessageId: "1793050001.123456",
      senderUserId: "USENDER",
    },
  };
  return {
    receipt,
    endpoint: {
      id: "endpoint",
      companyId: "company",
      assignedAgentId: "ceo",
      provider: "slack",
      providerAccountId: "TWORKSPACE",
      botExternalId: "UBOT",
    } as ChatEndpoint,
    conversation: {
      id: "conversation",
      endpointId: "endpoint",
      companyId: "company",
      issueId: "issue",
      externalConversationId: "slack:CCHANNEL",
      externalThreadId: "slack:CCHANNEL:1793050000.123456",
    } as ChatConversation,
    binding: {
      endpointId: "endpoint",
      conversationId: "conversation",
      provider: "slack",
      assignedAgentLocked: true,
    } as ExternalChannelBindingSummary,
    comment: {
      id: "comment",
      body: "Exact canonical query.",
      authorUserId: "human",
      metadata: { sourceChannel: "slack" },
    },
    canonicalQuery: "Exact canonical query.",
    companyId: "company",
    agentId: "ceo",
  };
}
describe("finite real Slack companion prerequisites and source binding", () => {
  it("requires each explicit disposable provider resource and a distinct actual human sender", () => {
    expect(() => assertSlackFixture(binding())).not.toThrow();
    const other = binding();
    other.resourceIds = other.resourceIds.filter((id) => id !== "USENDER");
    expect(() => assertSlackFixture(other)).toThrow(/allowlisted/);
    const bot = binding();
    bot.prerequisites.senderUserId = "UBOT";
    expect(() => assertSlackFixture(bot)).toThrow(/real linked human/);
  });
  it("refuses arbitrary Slack methods, another app/channel and unscoped post requests", () => {
    expect(() =>
      assertSlackCall(binding(), "sender", "chat.postMessage", {
        channel: "CCHANNEL",
        text: "Exact original query",
      }),
    ).not.toThrow();
    for (const action of [
      () => assertSlackCall(binding(), "sender", "users.list", {}),
      () =>
        assertSlackCall(binding(), "sender", "chat.postMessage", {
          channel: "COTHER",
        }),
      () => assertSlackCall(binding(), "sender", "chat.postMessage", {}),
      () =>
        assertSlackCall(binding(), "configuration", "apps.manifest.update", {
          app_id: "AOTHER",
        }),
    ])
      expect(action).toThrow();
  });
  it("accepts exact canonical linked-human source identity across the actual public DTOs", () =>
    expect(slackIngressMatches(ingress())).toBe(true));
  it("rejects copied company hints, wrong sender/comment, wrong thread, lost canonical bytes and missing dispatch", () => {
    for (const mutate of [
      (i: ReturnType<typeof ingress>) => {
        i.endpoint.companyId = "another-company";
      },
      (i: ReturnType<typeof ingress>) => {
        i.receipt.provider.senderUserId = "UBOT";
      },
      (i: ReturnType<typeof ingress>) => {
        i.comment.authorUserId = "another-human";
      },
      (i: ReturnType<typeof ingress>) => {
        i.comment.body = "A rewritten easier query.";
      },
      (i: ReturnType<typeof ingress>) => {
        i.conversation.externalThreadId = "slack:CCHANNEL:1793050009.123456";
      },
      (i: ReturnType<typeof ingress>) => {
        i.conversation.externalConversationId = "CCHANNEL";
      },
      (i: ReturnType<typeof ingress>) => {
        i.binding.conversationId = "another-conversation";
      },
      (i: ReturnType<typeof ingress>) => {
        i.receipt.providerCalls = 0;
      },
    ]) {
      const i = ingress();
      mutate(i);
      expect(slackIngressMatches(i)).toBe(false);
    }
  });
});

it("bounds official file transport destinations without forwarding a bearer to redirects or lookalike hosts", () => {
  expect(
    slackFileDestination("https://files.slack.com/upload/v1/owned").hostname,
  ).toBe("files.slack.com");
  for (const url of [
    "http://files.slack.com/file",
    "https://files.slack.com.evil.test/file",
    "https://files.slack.com:444/file",
    "https://user:secret@files.slack.com/file",
    "https://files.slack.com/file#secret",
  ])
    expect(() => slackFileDestination(url)).toThrow();
});

it("uploads only actual owned-thread bytes and independently validates bot file author/thread/size before download", async () => {
  const { slackProvider } = await import("./external-slack-provider.js");
  const b = binding(),
    sent: string[] = [],
    bytes = Buffer.from("Actual finished memo bytes"),
    secretRegistry: string[] = [];
  let wrongAuthor = false;
  const ctx = {
    input: {
      privateSecrets: secretRegistry,
      privateInputs: { read: () => "synthetic-token" },
    },
  } as unknown as import("../chat-catalog-contract.js").ChatCatalogContext;
  const client = slackProvider(ctx, b, (async (url, options) => {
    const value = String(url);
    sent.push(value);
    if (value.startsWith("https://files.slack.com/")) {
      expect(options?.redirect).toBe("error");
      return new Response(bytes);
    }
    const method = value.split("/").at(-1);
    const result =
      method === "chat.postMessage"
        ? { ok: true, channel: "CCHANNEL", ts: "1793050002.123456" }
        : method === "files.getUploadURLExternal"
          ? {
              ok: true,
              file_id: "FUPLOAD",
              upload_url: "https://files.slack.com/upload/v1/private",
            }
          : method === "conversations.replies"
            ? {
                ok: true,
                messages: [
                  {
                    ts: "1793050003.123456",
                    thread_ts: "1793050002.123456",
                    user: "UBOT",
                    files: [{ id: "FOUTPUT" }],
                  },
                ],
              }
            : method === "files.info"
              ? {
                  ok: true,
                  file: {
                    id: "FOUTPUT",
                    user: wrongAuthor ? "UOTHER" : "UBOT",
                    size: bytes.length,
                    url_private_download:
                      "https://files.slack.com/private/result",
                    permalink:
                      "https://owned.slack.com/files/UBOT/FOUTPUT/result.md",
                  },
                }
              : { ok: true };
    return new Response(JSON.stringify(result));
  }) as typeof fetch);
  const args = {
    filename: "brief.md",
    bytes,
    query: "Unchanged query",
    threadId: "1793050002.123456",
    signal: AbortSignal.timeout(10000),
  };
  await expect(client.uploadBrief(args)).rejects.toThrow(/owned-thread/);
  expect(sent).toHaveLength(0);
  await client.call("sender", "chat.postMessage", {
    channel: "CCHANNEL",
    text: "Actual owned root",
  });
  await expect(client.uploadBrief(args)).resolves.toMatchObject({
    id: "FUPLOAD",
    byteSize: bytes.length,
  });
  await expect(
    client.readThreadFile(args.threadId, "FOUTPUT", "bot"),
  ).resolves.toMatchObject({
    bytes,
    byteSize: bytes.length,
    messageId: "1793050003.123456",
  });
  expect(secretRegistry).toContain("https://files.slack.com/upload/v1/private");
  wrongAuthor = true;
  const count = sent.filter(
    (url) => url === "https://files.slack.com/private/result",
  ).length;
  await expect(
    client.readThreadFile(args.threadId, "FOUTPUT", "bot"),
  ).rejects.toThrow(/author\/size/);
  expect(
    sent.filter((url) => url === "https://files.slack.com/private/result"),
  ).toHaveLength(count);
});

it("cleans only messages proven created by this exact private client; arbitrary delete remains unavailable", async () => {
  const { slackProvider } = await import("./external-slack-provider.js");
  const b = binding(),
    requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const ctx = {
    input: {
      privateSecrets: [],
      privateInputs: { read: () => "synthetic-private-token" },
    },
  } as unknown as import("../chat-catalog-contract.js").ChatCatalogContext;
  const client = slackProvider(ctx, b, (async (url, options) => {
    const method = String(url).split("/").at(-1)!,
      body = JSON.parse(String(options?.body));
    requests.push({ method, body });
    return new Response(
      JSON.stringify(
        method === "chat.postMessage"
          ? { ok: true, channel: "CCHANNEL", ts: "1793050002.123456" }
          : method === "conversations.replies"
            ? {
                ok: true,
                messages: [
                  {
                    ts: "1793050003.123456",
                    thread_ts: "1793050002.123456",
                    user: "UBOT",
                  },
                  {
                    ts: "1793050004.123456",
                    thread_ts: "1793050002.123456",
                    user: "UOTHER",
                  },
                ],
              }
            : { ok: true },
      ),
      { status: 200 },
    );
  }) as typeof fetch);
  await expect(
    client.call("sender", "chat.delete", {
      channel: "CCHANNEL",
      ts: "1793059999.123456",
    }),
  ).rejects.toThrow(/finite/);
  await client.call("sender", "chat.postMessage", {
    channel: "CCHANNEL",
    text: "Actual disposable creation",
  });
  await client.cleanupOwned();
  await client.cleanupOwned();
  expect(requests).toEqual([
    {
      method: "chat.postMessage",
      body: { channel: "CCHANNEL", text: "Actual disposable creation" },
    },
    {
      method: "conversations.replies",
      body: { channel: "CCHANNEL", ts: "1793050002.123456", limit: 100 },
    },
    {
      method: "chat.delete",
      body: { channel: "CCHANNEL", ts: "1793050003.123456" },
    },
    {
      method: "chat.delete",
      body: { channel: "CCHANNEL", ts: "1793050002.123456" },
    },
  ]);
});
