import { z } from "zod";
import { GITHUB_REVIEW_EVENTS } from "../types/chat-github.js";

export const githubIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const githubCommitSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/i)
  .transform((value) => value.toLowerCase());
const shortList = z.array(z.string().trim().min(1).max(256)).max(100);
const prompts = z
  .object({
    opened: z.string().max(12000),
    synchronize: z.string().max(12000),
    reopened: z.string().max(12000),
    ready_for_review: z.string().max(12000),
    mention: z.string().max(12000),
    comment: z.string().max(12000),
  })
  .strict();
export const githubReviewPolicySchema = z
  .object({
    invocation: z.enum(["mentions_only", "linked_authors", "allowed_authors"]),
    events: z
      .array(z.enum(GITHUB_REVIEW_EVENTS))
      .max(GITHUB_REVIEW_EVENTS.length),
    reviewDrafts: z.boolean(),
    reviewBotAuthors: z.boolean(),
    includeAuthors: shortList,
    excludeAuthors: shortList,
    targetBranches: shortList,
    excludedBranches: shortList,
    requiredLabels: shortList,
    excludedLabels: shortList,
    ignoredPaths: shortList,
    instructions: z.string().max(24000),
    prompts,
    findingCategories: shortList,
    minimumCommentSeverity: z.enum(["info", "warning", "error"]),
    publishSummary: z.boolean(),
    publishInline: z.boolean(),
    allowApprove: z.boolean(),
    allowRequestChanges: z.boolean(),
    ratingThreshold: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.null(),
    ]),
  })
  .strict();
const person = {
  githubUserId: githubIdSchema,
  login: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/),
  automaticReviews: z.boolean(),
};
export const githubAllowedPersonSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...person, kind: z.literal("member"), userId: z.string().min(1) })
    .strict(),
  z
    .object({
      ...person,
      kind: z.literal("guest"),
      sponsorUserId: z.string().min(1),
      permissionProfile: z.literal("restricted"),
    })
    .strict(),
]);
export const githubChatConfigurationSchema = z
  .object({
    version: z.literal(1),
    toolsEnabled: z.boolean(),
    responsibleUserId: z.string().min(1),
    memberAccess: z.enum(["all_linked", "selected"]),
    people: z.array(githubAllowedPersonSchema).max(500),
    defaults: githubReviewPolicySchema,
    repositories: z
      .record(githubIdSchema, githubReviewPolicySchema.partial())
      .refine((value) => Object.keys(value).length <= 500),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.people.map((person) => person.githubUserId)).size !==
      value.people.length
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["people"],
        message: "Each GitHub account can be allowed only once.",
      });
  });
export const updateGitHubChatConfigurationSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    configuration: githubChatConfigurationSchema,
  })
  .strict();
export const githubReviewAssessmentSchema = z
  .object({
    reviewedCommit: githubCommitSchema,
    score: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    complete: z.boolean(),
    summary: z.string().trim().min(1).max(24000),
    rationale: z.string().trim().min(1).max(12000),
    coverage: z
      .object({
        reviewedPaths: z.array(z.string().min(1).max(1024)).max(5000),
        omittedPaths: z.array(z.string().min(1).max(1024)).max(5000),
        limitations: shortList,
      })
      .strict(),
    findings: z
      .array(
        z
          .object({
            key: z.string().min(1).max(160),
            path: z.string().min(1).max(1024),
            line: z.number().int().positive(),
            side: z.enum(["LEFT", "RIGHT"]),
            severity: z.enum(["info", "warning", "error"]),
            category: z.string().min(1).max(80),
            body: z.string().trim().min(1).max(12000),
          })
          .strict(),
      )
      .max(300),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.complete && value.coverage.reviewedPaths.length === 0)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverage"],
        message: "A complete assessment must identify reviewed files.",
      });
    const keys = value.findings.map(
      (f) => `${f.key}:${f.path}:${f.side}:${f.line}`,
    );
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "Duplicate findings are not allowed.",
      });
  });
