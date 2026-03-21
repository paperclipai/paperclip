import { z } from "zod";

export const MOCKUP_STATUSES = ["draft", "in_review", "approved", "rejected"] as const;
export type MockupStatus = (typeof MOCKUP_STATUSES)[number];

export const MOCKUP_VIEWPORTS = ["mobile", "tablet", "desktop"] as const;
export type MockupViewport = (typeof MOCKUP_VIEWPORTS)[number];

export const MOCKUP_FIDELITY_LEVELS = ["low", "medium", "high"] as const;
export type MockupFidelityLevel = (typeof MOCKUP_FIDELITY_LEVELS)[number];

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ["in_review"],
  in_review: ["approved", "rejected"],
  rejected: ["draft"],
};

export function isValidStatusTransition(from: string, to: string): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export const createMockupMetadataSchema = z.object({
  title: z.string().trim().min(1).max(255),
  viewport: z.enum(MOCKUP_VIEWPORTS).optional().default("desktop"),
  fidelityLevel: z.enum(MOCKUP_FIDELITY_LEVELS).optional().default("high"),
  notes: z.string().max(4096).optional().nullable(),
});
export type CreateMockupMetadata = z.infer<typeof createMockupMetadataSchema>;

export const updateMockupStatusSchema = z.object({
  status: z.enum(MOCKUP_STATUSES),
});
export type UpdateMockupStatus = z.infer<typeof updateMockupStatusSchema>;

export const listMockupsQuerySchema = z.object({
  status: z.enum(MOCKUP_STATUSES).optional(),
  title: z.string().optional(),
});
export type ListMockupsQuery = z.infer<typeof listMockupsQuerySchema>;
