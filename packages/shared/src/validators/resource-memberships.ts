import { z } from "zod";
import { RESOURCE_MEMBERSHIP_STATES } from "../types/resource-memberships.js";

export const resourceMembershipStateSchema = z.enum(RESOURCE_MEMBERSHIP_STATES);

export const updateResourceMembershipSchema = z.object({
  state: resourceMembershipStateSchema,
});

export type UpdateResourceMembership = z.infer<typeof updateResourceMembershipSchema>;
