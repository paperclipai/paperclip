import { z } from "zod";
import { HUMAN_COMPANY_MEMBERSHIP_ROLES } from "../constants.js";
import { EXPERIMENTAL_FEATURE_KEYS } from "../experimental-features.js";

export const experimentalFeatureKeySchema = z.enum(EXPERIMENTAL_FEATURE_KEYS);
export const experimentalAgentProviderSchema = z.enum(["claude", "codex"]);

export const experimentalAgentDualModeConfigSchema = z
  .object({
    primaryAgent: experimentalAgentProviderSchema.optional(),
    primaryModel: z.string().trim().min(1).nullable().optional(),
    secondaryAgent: experimentalAgentProviderSchema.optional(),
    secondaryModel: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export const experimentalUnauthenticatedLoginConfigSchema = z
  .object({
    accessLevel: z.enum(HUMAN_COMPANY_MEMBERSHIP_ROLES).optional(),
  })
  .strict();

export const companyExperimentalFeaturesConfigSchema = z
  .object({
    enabledFeatures: z.record(experimentalFeatureKeySchema, z.boolean()).optional(),
    unauthenticatedLogin: experimentalUnauthenticatedLoginConfigSchema.optional(),
    agentDualMode: experimentalAgentDualModeConfigSchema.optional(),
  })
  .strict();
