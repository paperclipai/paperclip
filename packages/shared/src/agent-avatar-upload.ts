import { z } from "zod";
import { agentAvatarFocusSchema } from "./agent-appearance.js";

export const MAX_AGENT_AVATAR_BYTES = 512 * 1024;
const imageBase64Schema = z.string().min(4).max(4 * Math.ceil(MAX_AGENT_AVATAR_BYTES / 3))
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
/** Raw PNG/JPEG/WebP bytes, not a URL or a data URL. Null restores the Paperclip character. */
const setAgentAvatarImageSchema = z.object({
  imageBase64: imageBase64Schema.nullable(),
}).strict();
const setAgentAvatarFocusSchema = z.object({
  avatarFocus: agentAvatarFocusSchema,
}).strict();
export const setAgentAvatarSchema = z.union([setAgentAvatarImageSchema, setAgentAvatarFocusSchema]);
export type SetAgentAvatarInput = z.infer<typeof setAgentAvatarSchema>;
