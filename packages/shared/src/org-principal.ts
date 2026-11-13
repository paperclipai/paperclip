import { z } from "zod";

export const ORG_PRINCIPAL_TYPES = ["agent", "user"] as const;
export type OrgPrincipalType = (typeof ORG_PRINCIPAL_TYPES)[number];

export const orgPrincipalRefSchema = z.object({
  type: z.enum(ORG_PRINCIPAL_TYPES),
  id: z.string().trim().min(1).max(256),
}).strict();

export type OrgPrincipalRef = z.infer<typeof orgPrincipalRefSchema>;

export function orgPrincipalKey(ref: OrgPrincipalRef | null | undefined): string | null {
  if (!ref?.id) return null;
  return `${ref.type}:${ref.id}`;
}
