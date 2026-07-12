import { z } from "zod";
import { RESOURCE_MEMBERSHIP_STATES } from "../types/resource-memberships.js";

export const resourceMembershipStateSchema = z.enum(RESOURCE_MEMBERSHIP_STATES);

export const updateResourceMembershipSchema = z.object({
  state: resourceMembershipStateSchema.optional(),
  starred: z.boolean().optional(),
}).refine((value) => value.state !== undefined || value.starred !== undefined, {
  message: "state or starred is required",
}).refine((value) => !(value.state === "left" && value.starred === true), {
  message: "starred resources must be joined",
  path: ["starred"],
});

export type UpdateResourceMembership = z.infer<typeof updateResourceMembershipSchema>;
