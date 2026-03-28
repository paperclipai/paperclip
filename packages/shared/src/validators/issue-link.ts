import { z } from "zod";
import { ISSUE_LINK_TYPES } from "../constants.js";

export const createIssueLinkSchema = z.object({
  targetId: z.string().uuid(),
  linkType: z.enum(ISSUE_LINK_TYPES).optional().default("triggers"),
});

export type CreateIssueLink = z.infer<typeof createIssueLinkSchema>;
