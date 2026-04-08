import { z } from "zod";

export const ROOM_STATUSES = ["active", "archived"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ROOM_MESSAGE_TYPES = ["text", "action", "status", "system"] as const;
export type RoomMessageType = (typeof ROOM_MESSAGE_TYPES)[number];

export const ROOM_ACTION_STATUSES = ["pending", "executed", "failed"] as const;
export type RoomActionStatus = (typeof ROOM_ACTION_STATUSES)[number];

export const createRoomSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional().nullable(),
});
export type CreateRoom = z.infer<typeof createRoomSchema>;

export const updateRoomSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().optional().nullable(),
  status: z.enum(ROOM_STATUSES).optional(),
});
export type UpdateRoom = z.infer<typeof updateRoomSchema>;

export const addRoomParticipantSchema = z.object({
  agentId: z.string().uuid().optional(),
  userId: z.string().optional(),
  role: z.enum(["owner", "member"]).optional().default("member"),
});
export type AddRoomParticipant = z.infer<typeof addRoomParticipantSchema>;

export const sendRoomMessageSchema = z
  .object({
    type: z.enum(ROOM_MESSAGE_TYPES).optional().default("text"),
    body: z.string().min(1),
    actionPayload: z.record(z.unknown()).optional().nullable(),
    actionTargetAgentId: z.string().uuid().optional().nullable(),
    replyToId: z.string().uuid().optional().nullable(),
  })
  .refine(
    (data) => {
      if (data.type === "action") {
        return !!data.actionTargetAgentId;
      }
      return true;
    },
    { message: "action messages require actionTargetAgentId" },
  );
export type SendRoomMessage = z.infer<typeof sendRoomMessageSchema>;

export const updateActionStatusSchema = z.object({
  actionStatus: z.enum(ROOM_ACTION_STATUSES),
});
export type UpdateActionStatus = z.infer<typeof updateActionStatusSchema>;

export const linkRoomIssueSchema = z.object({
  issueId: z.string().uuid(),
});
export type LinkRoomIssue = z.infer<typeof linkRoomIssueSchema>;
