import { z } from "zod";
import { COMPANY_STATUSES, PAUSE_REASONS } from "./constants.js";
import { interactionResolverGovernanceSchema } from "./validators/company.js";
import type { BoardBootstrap } from "./types/board-bootstrap.js";
import type { Company } from "./types/company.js";

const companySnapshotSchema: z.ZodType<Company> = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(COMPANY_STATUSES),
  pauseReason: z.enum(PAUSE_REASONS).nullable(),
  pausedAt: z.coerce.date().nullable(),
  issuePrefix: z.string().min(1),
  issueCounter: z.number(),
  budgetMonthlyCents: z.number(),
  spentMonthlyCents: z.number(),
  defaultResponsibleUserId: z.string().nullable(),
  defaultDecisionOwnerUserId: z.string().nullable().default(null),
  budgetOwnerUserId: z.string().nullable().default(null),
  requireBoardApprovalForNewAgents: z.boolean(),
  interactionResolverGovernance: interactionResolverGovernanceSchema,
  feedbackDataSharingEnabled: z.boolean(),
  feedbackDataSharingConsentAt: z.coerce.date().nullable(),
  feedbackDataSharingConsentByUserId: z.string().nullable(),
  feedbackDataSharingTermsVersion: z.string().nullable(),
  logoAssetId: z.string().nullable(),
  logoUrl: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const bootstrapSchema: z.ZodType<BoardBootstrap> = z.object({
  userId: z.string().min(1),
  companies: z.array(companySnapshotSchema),
  boardAccess: z.object({
    userId: z.string().min(1),
    isInstanceAdmin: z.boolean(),
    companyIds: z.array(z.string().min(1)),
  }),
});

/** An unusable optional projection falls back to the existing authenticated reads. */
export function readBoardBootstrap(value: unknown, userId: string): BoardBootstrap | undefined {
  const parsed = bootstrapSchema.safeParse(value);
  return parsed.success && parsed.data.userId === userId && parsed.data.boardAccess.userId === userId
    ? parsed.data
    : undefined;
}
