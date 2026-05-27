import { z } from "zod";

export const proposalSourceTypeSchema = z.enum(["paste", "txt", "md", "docx", "pdf"]);
export const opcProjectModeSchema = z.enum(["advise", "take_charge"]);

export const createOPCProposalSchema = z
  .object({
    text: z.string().optional(),
    sourceType: proposalSourceTypeSchema.optional().default("paste"),
    filename: z.string().trim().min(1).optional().nullable(),
    mimeType: z.string().trim().min(1).optional().nullable(),
    fileContentBase64: z.string().trim().min(1).optional().nullable(),
    projectPath: z.string().trim().min(1).max(2_000).optional().nullable(),
    projectLink: z.string().trim().min(1).max(2_000).optional().nullable(),
    projectMode: opcProjectModeSchema.optional().default("advise"),
  })
  .superRefine((value, ctx) => {
    if (!value.text?.trim() && !value.fileContentBase64?.trim() && !value.projectPath?.trim() && !value.projectLink?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide proposal text, fileContentBase64, projectPath, or projectLink",
      });
    }
  });

export type CreateOPCProposal = z.infer<typeof createOPCProposalSchema>;

export const opcChatSchema = z
  .object({
    message: z.string().trim().min(1),
    decision: z
      .object({
        question: z.string().trim().min(1),
        selectedAnswer: z.string().trim().min(1),
        rationale: z.string().trim().optional().nullable(),
      })
      .optional(),
  })
  .strict();

export type OPCChat = z.infer<typeof opcChatSchema>;

export const approveOPCBlueprintSchema = z.object({}).strict();
export type ApproveOPCBlueprint = z.infer<typeof approveOPCBlueprintSchema>;

export const createOPCCompanySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    adapterType: z.string().trim().min(1).optional().default("process"),
    adapterConfig: z.record(z.string(), z.unknown()).optional().default({}),
    projectPath: z.string().trim().min(1).max(2_000).optional().nullable(),
    projectLink: z.string().trim().min(1).max(2_000).optional().nullable(),
    projectMode: opcProjectModeSchema.optional(),
  })
  .strict();

export type CreateOPCCompany = z.infer<typeof createOPCCompanySchema>;
