import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { loadConfig } from "./config.js";
import { verifySignature, signPayload } from "./crypto.js";
import { IntentEngine } from "./intent-engine.js";
import { PaperclipClient } from "./paperclip-client.js";
import { BridgeClient } from "./bridge-client.js";
import {
  InMemoryConversationStore,
  InMemoryIdentityStore,
} from "./store.js";
import type {
  InboundPayload,
  OutboundPayload,
  PaperclipWebhookEvent,
} from "./types.js";

const config = loadConfig();

const conversationStore = new InMemoryConversationStore();
const identityStore = new InMemoryIdentityStore();
const paperclip = new PaperclipClient(config);
const bridgeClient = new BridgeClient(config);
const intentEngine = new IntentEngine(config, conversationStore);

const app = Fastify({ logger: true });
await app.register(sensible);

app.get("/healthz", async () => ({ status: "ok", service: "hermes-gateway" }));

app.post<{ Body: InboundPayload }>("/api/v1/inbound", async (request, reply) => {
  const signature = request.headers["x-bridge-signature"] as string | undefined;
  if (!signature) {
    return reply.unauthorized("Missing X-Bridge-Signature");
  }

  const rawBody = JSON.stringify(request.body);
  if (!verifySignature(config.bridgeSharedSecret, rawBody, signature)) {
    return reply.unauthorized("Invalid signature");
  }

  const payload = request.body;

  const binding = await identityStore.findBinding(
    payload.platform,
    payload.sender.platformUserId,
  );

  const intent = await intentEngine.resolve(payload, binding);

  switch (intent.action) {
    case "unbound_user": {
      const outbound: OutboundPayload = {
        platform: payload.platform,
        recipient: {
          platformUserId: payload.sender.platformUserId,
          platformConversationId: payload.conversation.platformConversationId,
        },
        replyToMessageId: payload.messageId,
        content: {
          type: "text",
          text: "Please link your account first. Use /bind to connect your Paperclip identity.",
        },
      };
      try {
        await bridgeClient.sendOutbound(outbound);
      } catch (err) {
        request.log.error({ err }, "Failed to send bind prompt to bridge");
      }
      return { accepted: true, action: "unbound_user" };
    }

    case "create_issue": {
      const issue = await paperclip.createIssue({
        title: intent.title,
        description: intent.description,
        metadata: {
          source: "hermes-gateway",
          platform: payload.platform,
          senderPlatformUserId: payload.sender.platformUserId,
          conversationId: payload.conversation.platformConversationId,
        },
      });

      await conversationStore.create({
        platform: payload.platform,
        platformUserId: payload.sender.platformUserId,
        platformConversationId: payload.conversation.platformConversationId,
        threadId: payload.conversation.threadId,
        paperclipIssueId: issue.id,
        paperclipCompanyId: config.paperclipCompanyId,
        paperclipUserId: binding!.paperclipUserId,
      });

      const outbound: OutboundPayload = {
        platform: payload.platform,
        recipient: {
          platformUserId: payload.sender.platformUserId,
          platformConversationId: payload.conversation.platformConversationId,
        },
        replyToMessageId: payload.messageId,
        content: {
          type: "text",
          text: `Created ${issue.identifier}: ${issue.title}`,
        },
      };
      try {
        await bridgeClient.sendOutbound(outbound);
      } catch (err) {
        request.log.error({ err }, "Failed to send confirmation to bridge");
      }

      return { accepted: true, action: "create_issue", issueId: issue.id };
    }

    case "append_comment": {
      await paperclip.addComment(intent.issueId, intent.body);

      const mapping = await conversationStore.findActiveMapping(
        payload.platform,
        payload.conversation.platformConversationId,
        payload.conversation.threadId,
      );
      if (mapping) {
        await conversationStore.updateLastActivity(mapping.id);
      }

      return { accepted: true, action: "append_comment", issueId: intent.issueId };
    }
  }
});

app.post<{ Body: PaperclipWebhookEvent }>(
  "/api/v1/paperclip-events",
  async (request, reply) => {
    const signature = request.headers["x-paperclip-signature"] as string | undefined;
    if (!signature) {
      return reply.unauthorized("Missing X-Paperclip-Signature");
    }

    const rawBody = JSON.stringify(request.body);
    if (!verifySignature(config.webhookSecret, rawBody, signature)) {
      return reply.unauthorized("Invalid signature");
    }

    const event = request.body;

    const mapping = await conversationStore.findByIssueId(event.issueId);
    if (!mapping) {
      return { accepted: true, action: "no_mapping" };
    }

    let messageText: string;
    switch (event.event) {
      case "issue.completed":
        await conversationStore.markCompleted(mapping.id);
        messageText = `Task completed! Issue ${event.issueId} is done.`;
        break;
      case "issue.status_changed":
        messageText = `Status update: ${(event.payload as Record<string, unknown>)["newStatus"] || "changed"}`;
        break;
      case "issue.comment_added":
        messageText = `Update: ${(event.payload as Record<string, unknown>)["body"] || "New comment added"}`;
        break;
      default:
        return { accepted: true, action: "unknown_event" };
    }

    const outbound: OutboundPayload = {
      platform: mapping.platform,
      recipient: {
        platformUserId: mapping.platformUserId,
        platformConversationId: mapping.platformConversationId,
      },
      content: { type: "text", text: messageText },
    };

    try {
      await bridgeClient.sendOutbound(outbound);
    } catch (err) {
      request.log.error({ err }, "Failed to push event to bridge");
    }

    return { accepted: true, action: "pushed" };
  },
);

app.post<{
  Body: { platform: string; outboundUrl: string };
}>("/api/v1/bridges/register", async (request, reply) => {
  const { platform, outboundUrl } = request.body;
  if (!platform || !outboundUrl) {
    return reply.badRequest("platform and outboundUrl required");
  }
  bridgeClient.registerBridge(platform, outboundUrl);
  return { registered: true, platform };
});

app.post<{
  Body: {
    platform: string;
    platformUserId: string;
    paperclipUserId: string;
    paperclipCompanyId: string;
  };
}>("/api/v1/identity/bind", async (request, reply) => {
  const { platform, platformUserId, paperclipUserId, paperclipCompanyId } =
    request.body;
  if (!platform || !platformUserId || !paperclipUserId) {
    return reply.badRequest("platform, platformUserId, and paperclipUserId required");
  }

  const existing = await identityStore.findBinding(
    platform as InboundPayload["platform"],
    platformUserId,
  );
  if (existing) {
    return { bound: true, existing: true, bindingId: existing.id };
  }

  const binding = await identityStore.createBinding({
    platform: platform as InboundPayload["platform"],
    platformUserId,
    paperclipUserId,
    paperclipCompanyId: paperclipCompanyId || config.paperclipCompanyId,
  });

  return { bound: true, existing: false, bindingId: binding.id };
});

async function registerWebhookSubscription() {
  const callbackUrl = `${config.gatewayBaseUrl}/api/v1/paperclip-events`;
  try {
    const result = await paperclip.registerWebhook({
      url: callbackUrl,
      events: ["issue.status_changed", "issue.comment_added", "issue.completed"],
      secret: config.webhookSecret,
    });
    app.log.info({ webhookId: result.id, callbackUrl }, "Webhook subscription registered");
  } catch (err) {
    app.log.warn({ err, callbackUrl }, "Failed to register webhook subscription (will retry on next restart)");
  }
}

async function start() {
  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`Hermes Gateway listening on port ${config.port}`);
    await registerWebhookSubscription();
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

start();

export { app };
