import { z } from "zod";
import { AGENT_ROLES } from "./constants.js";
import type { DotBinding, DotConnection, DotInvitation } from "./dot-invitations.js";

export const createGrokInvitationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  botName: z.string().trim().min(1).max(100),
  role: z.enum(AGENT_ROLES).default("general"),
  reportsTo: z.uuid().nullable().optional(),
}).strict();
export const configureGrokRoutineSchema = z.object({
  bindingId: z.uuid(), expectedRevision: z.number().int().nonnegative(),
  botName: z.string().trim().min(1).max(100),
  webhookUrl: z.string().min(1).max(2048), webhookKey: z.string().min(1).max(16384),
}).strict();
export const verifyGrokRoutineSchema = z.object({ bindingId: z.uuid(), requestId: z.uuid() }).strict();
export const retryGrokDeliverySchema = z.object({ correlationId: z.uuid() }).strict();
export const pairGrokBindingSchema = z.object({ replaceBindingId: z.uuid().optional() }).strict();
export const stopGrokWorkSchema = z.object({ expectedRunId: z.uuid().optional() }).strict();
export const recoverGrokRoutineSchema = z.object({ inspectedRemoteWork: z.literal(true) }).strict();
export type CreateGrokInvitation = z.input<typeof createGrokInvitationSchema>;
export type ConfigureGrokRoutine = z.infer<typeof configureGrokRoutineSchema>;
export interface GrokRoutineState {
  bindingId: string; botName: string; revision: number; configured: boolean;
  verified: boolean; verifiedAt: string | null; lastContactAt: string | null; recoveryNeeded: boolean;
  lastExchange: { id: string; kind: "verify" | "mailbox_updated" | "authority_revoked";
    status: "prepared" | "sending" | "accepted" | "rejected" | "unknown" | "acknowledged" | "cancelled";
    httpStatus: number | null; sentAt: string | null; acknowledgedAt: string | null; expiresAt: string } | null;
}
export interface GrokBinding extends DotBinding {
  providerKind: "grok_bot"; wakeVerified: boolean; routine: GrokRoutineState | null;
  assignment?: { id: string; runId: string; status: string; lastActivityAt: string; attentionRequired: boolean } | null;
}
export interface GrokInvitation extends Omit<DotInvitation, "agent" | "binding"> {
  agent: DotInvitation["agent"] & { role: typeof AGENT_ROLES[number]; reportsTo: string | null; botName: string };
  binding: GrokBinding | null;
}
export interface GrokConnection extends Omit<DotConnection, "binding"> { binding: GrokBinding | null; recoveryNeeded: boolean; queuedTaskCount?: number; currentTask?: { id: string; identifier: string; title: string } | null }
