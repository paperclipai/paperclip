import { z } from "zod";

export const projectPortfolioStateSchema = z.enum([
  "primary",
  "active",
  "blocked",
  "paused",
  "parked",
  "closed",
]);

export const projectPhaseSchema = z.enum([
  "exploration",
  "validation",
  "build",
  "distribution",
]);

export const projectConstraintLaneSchema = z.enum([
  "product",
  "customer",
  "distribution",
]);

export const projectControlPlaneLastOutputSchema = z.object({
  kind: z.enum(["issue", "work_product", "document", "external_link", "note"]),
  id: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
});

export const projectControlPlaneStateSchema = z.object({
  portfolioState: projectPortfolioStateSchema,
  currentPhase: projectPhaseSchema,
  constraintLane: projectConstraintLaneSchema.nullable(),
  nextSmallestAction: z.string().nullable(),
  blockerSummary: z.string().nullable(),
  latestEvidenceChanged: z.string().nullable(),
  resumeBrief: z.string().nullable(),
  doNotRethink: z.string().nullable(),
  killCriteria: z.string().nullable(),
  lastMeaningfulOutput: projectControlPlaneLastOutputSchema.nullable(),
});

export type ProjectControlPlaneStateInput = z.infer<typeof projectControlPlaneStateSchema>;

export const updateProjectControlPlaneSchema = projectControlPlaneStateSchema
  .pick({
    portfolioState: true,
    currentPhase: true,
    constraintLane: true,
    nextSmallestAction: true,
    blockerSummary: true,
    latestEvidenceChanged: true,
    resumeBrief: true,
    doNotRethink: true,
    killCriteria: true,
    lastMeaningfulOutput: true,
  })
  .partial();

export type UpdateProjectControlPlane = z.infer<typeof updateProjectControlPlaneSchema>;

export const projectPortfolioSummarySchema = z.object({
  projectId: z.string().uuid(),
  name: z.string(),
  color: z.string().nullable(),
  controlPlaneState: projectControlPlaneStateSchema.nullable(),
  controlPlaneUpdatedAt: z.string().nullable(),
  staleStatus: z.enum(["fresh", "aging", "stale", "critical"]),
  attentionScore: z.number(),
  warnings: z.array(z.string()),
});
