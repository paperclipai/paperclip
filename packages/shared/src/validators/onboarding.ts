import { z } from "zod";

export const onboardingScanRepoKindSchema = z.enum(["empty", "brownfield", "restricted", "too_large"]);

export const onboardingScanRequestSchema = z.object({
  path: z.string().min(1),
  maxDepth: z.number().int().min(0).max(3).optional().default(3),
  includeManifests: z.boolean().optional().default(true),
});

export const onboardingScanWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.string().optional(),
});

export const onboardingScanResponseSchema = z.object({
  displayPath: z.string(),
  repoKind: onboardingScanRepoKindSchema,
  counts: z.object({
    directories: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    ignoredDirectories: z.number().int().nonnegative(),
    symlinks: z.number().int().nonnegative(),
  }),
  detectedStacks: z.array(z.string()),
  packageManagers: z.array(z.string()),
  safeManifestIndicators: z.array(z.string()),
  warnings: z.array(onboardingScanWarningSchema),
  boundedSanitizedSummary: z.object({
    projectName: z.string().nullable(),
    dependencies: z.array(z.string()).optional(),
    devDependencies: z.array(z.string()).optional(),
    hasReadme: z.boolean(),
    directoryStructure: z.array(z.string()),
  }),
});

export const onboardingPickDirectoryResponseSchema = z.object({
  path: z.string().nullable(),
  cancelled: z.boolean(),
});

export const onboardingRecommendedAdapterSchema = z.enum(["claude_local", "codex_local", "agy_local"]);

export const onboardingRecommendationRequestSchema = z.object({
  scanSummary: onboardingScanResponseSchema,
  userGoals: z.string().max(10_000).optional().default(""),
});

export const onboardingRecommendationSquadSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  adapterType: onboardingRecommendedAdapterSchema,
  model: z.string().nullable(),
  permissions: z.record(z.unknown()).default({}),
});

export const onboardingLocalAuthCheckSchema = z.object({
  adapterType: onboardingRecommendedAdapterSchema,
  provider: z.enum(["anthropic", "openai", "google"]),
  label: z.string().min(1),
  authMethod: z.literal("local_oauth"),
  required: z.boolean(),
  quotaPolicy: z.enum(["known", "warn_unknown"]),
  setupHint: z.string().min(1),
});

export const onboardingOptionalSecretSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  category: z.enum(["source_control", "runtime_env", "deployment", "webhook", "other"]),
  status: z.enum(["recommended", "optional"]),
  storageProvider: z.literal("local_encrypted"),
  requiredForOnboarding: z.literal(false),
  reason: z.string().min(1),
  setupHint: z.string().min(1),
});

export const onboardingAdapterModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const onboardingAdapterOptionSchema = z.object({
  adapterType: onboardingRecommendedAdapterSchema,
  provider: z.enum(["anthropic", "openai", "google"]),
  label: z.string().min(1),
  description: z.string().min(1),
  authLabel: z.string().min(1),
  quotaPolicy: z.enum(["known", "warn_unknown"]),
  lockedModel: z.string().nullable(),
  models: z.array(onboardingAdapterModelOptionSchema),
});

export const onboardingAdapterOptionsResponseSchema = z.object({
  adapters: z.array(onboardingAdapterOptionSchema),
});

export const onboardingRecommendationResponseSchema = z.object({
  recommendationSource: z.enum(["ai", "deterministic"]).default("deterministic"),
  recommendationWarnings: z.array(z.string().min(1)).default([]),
  proposedCompany: z.object({
    name: z.string().min(1),
    description: z.string().nullable(),
  }),
  proposedSquads: z.array(onboardingRecommendationSquadSchema),
  proposedMcps: z.array(z.object({
    name: z.string().min(1),
    status: z.enum(["recommended", "optional"]),
  })),
  proposedRequiredSecrets: z.array(z.string().min(1)),
  proposedOptionalSecrets: z.array(onboardingOptionalSecretSchema).default([]),
  proposedLocalAuthChecks: z.array(onboardingLocalAuthCheckSchema).default([]),
  adapterOptions: z.array(onboardingAdapterOptionSchema).default([]),
  proposedProjectWorkspace: z.object({
    name: z.string().min(1),
    cwd: z.string().min(1),
  }),
  proposedStarterIssue: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    assigneeRole: z.string().min(1),
  }),
});

export const onboardingApplySquadSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  adapterType: onboardingRecommendedAdapterSchema,
  model: z.string().nullable(),
  permissions: z.record(z.unknown()).default({}),
}).superRefine((squad, ctx) => {
  const normalizedModel = squad.model?.trim().toLowerCase() ?? "";
  if (squad.adapterType === "codex_local" && normalizedModel.startsWith("gemini")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "codex_local squads must use Codex/OpenAI model IDs, not Gemini model IDs",
      path: ["model"],
    });
  }
  if (squad.adapterType === "agy_local" && squad.model !== "gemini-3.5-flash") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "agy_local squads must use gemini-3.5-flash",
      path: ["model"],
    });
  }
});

export const onboardingApplyRequestSchema = z.object({
  proposedCompany: z.object({
    name: z.string().min(1),
    description: z.string().nullable().optional(),
  }),
  proposedSquads: z.array(onboardingApplySquadSchema).min(1).max(12),
  proposedProjectWorkspace: z.object({
    name: z.string().min(1),
    cwd: z.string().min(1),
  }),
  proposedStarterIssue: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    assigneeRole: z.string().min(1),
  }),
});

export const onboardingApplyResponseSchema = z.object({
  company: z.object({
    id: z.string().uuid(),
    name: z.string(),
    issuePrefix: z.string(),
  }),
  goal: z.object({
    id: z.string().uuid(),
    title: z.string(),
  }),
  agents: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    role: z.string(),
    adapterType: onboardingRecommendedAdapterSchema,
  })),
  project: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }),
  projectWorkspace: z.object({
    id: z.string().uuid(),
    name: z.string(),
    cwd: z.string(),
  }),
  starterIssue: z.object({
    id: z.string().uuid(),
    identifier: z.string(),
    title: z.string(),
    assigneeAgentId: z.string().uuid().nullable(),
  }),
});

export const onboardingSetupItemSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["pending", "deferred", "completed"]),
  href: z.string().min(1).optional(),
});

export const onboardingSetupStateSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  starterIssueId: z.string().uuid().nullable(),
  status: z.enum(["pending", "completed", "dismissed"]),
  source: z.string().min(1),
  items: z.array(onboardingSetupItemSchema),
  completedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const updateOnboardingSetupStateSchema = z.union([
  z.object({
    status: z.enum(["completed", "dismissed"]),
  }).strict(),
  z.object({
    itemKey: z.string().min(1),
    itemStatus: z.enum(["pending", "deferred", "completed"]),
  }).strict(),
]);

export type OnboardingScanRequest = z.infer<typeof onboardingScanRequestSchema>;
export type OnboardingScanResponse = z.infer<typeof onboardingScanResponseSchema>;
export type OnboardingScanWarning = z.infer<typeof onboardingScanWarningSchema>;
export type OnboardingPickDirectoryResponse = z.infer<typeof onboardingPickDirectoryResponseSchema>;
export type OnboardingAdapterOptionsResponse = z.infer<typeof onboardingAdapterOptionsResponseSchema>;
export type OnboardingRecommendationRequest = z.infer<typeof onboardingRecommendationRequestSchema>;
export type OnboardingRecommendationResponse = z.infer<typeof onboardingRecommendationResponseSchema>;
export type OnboardingApplyRequest = z.infer<typeof onboardingApplyRequestSchema>;
export type OnboardingApplyResponse = z.infer<typeof onboardingApplyResponseSchema>;
export type OnboardingSetupItem = z.infer<typeof onboardingSetupItemSchema>;
export type OnboardingSetupState = z.infer<typeof onboardingSetupStateSchema>;
export type UpdateOnboardingSetupState = z.infer<typeof updateOnboardingSetupStateSchema>;
