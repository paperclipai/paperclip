import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { emailSendSchema } from "@paperclipai/shared";
import { emailChannelService } from "../email-channels.js";
import { forbidden, notFound } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";

const AGENTMAIL_EMAIL_CONTRACT = {
  description:
    "Use an assigned AgentMail inbox for this task. Internal comments and final responses never send email. List inboxes, read the current email thread, explicitly send a new email child task or reply, and inspect delivery. Requires experimental email connections. A send needs a UUID idempotencyKey; preserve it and the identical payload on retry. A reply uses conversationId and replyToMessageId from thread; replyAll defaults false and excludes Bcc. Sending does not close the task.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["inboxes", "thread", "send", "delivery"],
      },
      publicationId: {
        type: "string",
        description: "Publication UUID returned by send, for delivery status.",
      },
      request: {
        type: "object",
        properties: {
          endpointId: { type: "string" },
          parentIssueId: {
            type: "string",
            description: "Current task UUID for a new email child task.",
          },
          conversationId: { type: "string" },
          replyToMessageId: { type: "string" },
          replyAll: { type: "boolean" },
          to: { type: "array", items: { type: "string" } },
          cc: { type: "array", items: { type: "string" } },
          bcc: { type: "array", items: { type: "string" } },
          subject: { type: "string" },
          text: { type: "string" },
          attachmentIds: { type: "array", items: { type: "string" } },
          idempotencyKey: { type: "string" },
        },
        required: ["endpointId", "text", "idempotencyKey"],
        additionalProperties: false,
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
} as const;
// Connector-owned definitions. They are never part of the universal runner catalog.
export const AGENTMAIL_TOOLS = [
  {
    name: "agentmail_inboxes",
    action: "inboxes",
    description: "List your active assigned AgentMail inboxes.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agentmail_read_thread",
    action: "thread",
    description:
      "Read the current task's AgentMail email thread, recipients, messages and attachments.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agentmail_send",
    action: "send",
    description: AGENTMAIL_EMAIL_CONTRACT.description,
    inputSchema: {
      type: "object",
      properties: {
        request: AGENTMAIL_EMAIL_CONTRACT.inputSchema.properties.request,
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
  {
    name: "agentmail_delivery",
    action: "delivery",
    description:
      "Check delivery of an AgentMail publication belonging to your task.",
    inputSchema: {
      type: "object",
      properties: {
        publicationId:
          AGENTMAIL_EMAIL_CONTRACT.inputSchema.properties.publicationId,
      },
      required: ["publicationId"],
      additionalProperties: false,
    },
  },
] as const;

const schema = z
  .object({
    action: z.enum(["inboxes", "thread", "send", "delivery"]),
    request: emailSendSchema.optional(),
    publicationId: z.string().uuid().optional(),
  })
  .strict();

export async function executeAgentmailTool(
  db: Db,
  binding: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId: string;
    workMode?: string;
  },
  value: unknown,
) {
  if (
    !(await instanceSettingsService(db).getExperimental()).enableChatConnectors
  )
    throw forbidden("Experimental email connections are disabled");
  const input = schema.parse(value);
  // This facade only persists intents/reads. The app's durable email worker owns execution.
  const service = emailChannelService(db, {
    heartbeat: {
      wakeup: async () => {
        throw new Error("Task email facade cannot start a receive worker");
      },
    },
  });
  const inboxes = await service.assignedInboxes(
    binding.companyId,
    binding.agentId,
  );
  if (!inboxes.length) throw forbidden("No active assigned AgentMail inbox");
  if (input.action === "inboxes") return inboxes;
  await service.authorizeRead(binding.companyId, binding.issueId, {
    agentId: binding.agentId,
    runId: binding.runId,
  });
  const thread = await service.thread(binding.companyId, binding.issueId);
  if (thread && !inboxes.some((inbox) => inbox.id === thread.endpoint.id))
    throw notFound("Email task not found");
  if (input.action === "thread") return thread;
  if (input.action === "delivery") {
    if (!input.publicationId) throw forbidden("Publication ID required");
    const delivery = await service.publication(
      input.publicationId,
      binding.companyId,
    );
    await service.authorizeRead(binding.companyId, delivery.issueId, {
      agentId: binding.agentId,
      runId: binding.runId,
    });
    const target = await service.thread(binding.companyId, delivery.issueId);
    if (!target || !inboxes.some((inbox) => inbox.id === target.endpoint.id))
      throw notFound("Email delivery not found");
    return delivery;
  }
  if (binding.workMode && binding.workMode !== "standard")
    throw forbidden("Email sends require standard work mode");
  if (
    !input.request ||
    (input.request.parentIssueId &&
      input.request.parentIssueId !== binding.issueId) ||
    (input.request.conversationId &&
      input.request.conversationId !== thread?.conversationId)
  )
    throw forbidden("Email send must belong to the current task");
  return service.queueSend(binding.companyId, input.request, {
    agentId: binding.agentId,
    runId: binding.runId,
  });
}
