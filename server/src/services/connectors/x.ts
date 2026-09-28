import type { Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import type { XBinding, XChannelService } from "../x/service.js";
const controllers = new WeakMap<Db, XChannelService>();
export function registerXController(db: Db, controller: XChannelService) {
  controllers.set(db, controller);
  return () => {
    if (controllers.get(db) === controller) controllers.delete(db);
  };
}
const objectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
export const X_TOOLS = [
  {
    name: "x_read_thread",
    description:
      "Read this task's X messages, available parent context and authorized reply targets. Other posts are reference material.",
    inputSchema: objectSchema,
  },
  {
    name: "x_reply",
    description:
      "Request one public X reply to this interaction. Internal task activity never posts. Use one concise reply without Paperclip links. Preserve the UUID idempotencyKey; check x_delivery on uncertainty.",
    inputSchema: {
      type: "object",
      properties: {
        replyToPostId: { type: "string" },
        text: { type: "string" },
        idempotencyKey: { type: "string", format: "uuid" },
      },
      required: ["replyToPostId", "text", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "x_delivery",
    description:
      "Check a reply intent's delivery status and resulting X post ID. delivery_unknown must never be blindly reposted.",
    inputSchema: {
      type: "object",
      properties: { publicationId: { type: "string", format: "uuid" } },
      required: ["publicationId"],
      additionalProperties: false,
    },
  },
];
export async function xAssignedResource(
  db: Db,
  binding: {
    companyId: string;
    agentId: string;
    issueId?: string;
    runId?: string;
  },
) {
  if (!binding.issueId || !binding.runId) return [];
  try {
    const authority = await controllers.get(db)?.authority(binding as XBinding);
    return authority
      ? [
          {
            id: authority.endpoint.id,
            label: authority.endpoint.botUsername ?? "X",
            connectionId: authority.endpoint.connectionId,
            metadata: { conversationId: authority.conversation.id },
          },
        ]
      : [];
  } catch {
    return [];
  }
}
export async function executeXTool(
  db: Db,
  binding: XBinding,
  name: string,
  value: unknown,
) {
  const controller = controllers.get(db);
  if (!controller) throw forbidden("X task authority is unavailable");
  return controller.execute(binding, name, value);
}
