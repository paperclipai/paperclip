import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { emailSendSchema } from "@paperclipai/shared";
import { emailChannelService } from "../email-channels.js";
import { forbidden, notFound } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";

export const TASK_EMAIL_TOOL = {
  name: "task_email",
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
const schema = z
  .object({
    action: z.enum(["inboxes", "thread", "send", "delivery"]),
    request: emailSendSchema.optional(),
    publicationId: z.string().uuid().optional(),
  })
  .strict();

export async function executeTaskEmail(
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
  if (input.action === "inboxes")
    return (await service.list(binding.companyId)).filter(
      (e) => e.assignedAgentId === binding.agentId,
    );
  await service.authorizeRead(binding.companyId, binding.issueId, {
    agentId: binding.agentId,
    runId: binding.runId,
  });
  const thread = await service.thread(binding.companyId, binding.issueId);
  if (thread && thread.endpoint.assignedAgentId !== binding.agentId)
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
    if (target?.endpoint.assignedAgentId !== binding.agentId)
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
