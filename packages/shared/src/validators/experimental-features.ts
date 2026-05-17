import { z } from "zod";
import { EXPERIMENTAL_FEATURE_KEYS } from "../experimental-features.js";

export const experimentalFeatureKeySchema = z.enum(EXPERIMENTAL_FEATURE_KEYS);

export const companyExperimentalFeaturesConfigSchema = z
  .object({
    enabledFeatures: z.record(experimentalFeatureKeySchema, z.boolean()).optional(),
  })
  .strict();
