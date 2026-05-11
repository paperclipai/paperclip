import { z } from "zod";

export const APPLE_ADAPTER_DEFAULT_TIMEOUT_MS = 5_000;
export const APPLE_ADAPTER_DEFAULT_MAX_ATTEMPTS = 3;
export const APPLE_ADAPTER_DEFAULT_BASE_DELAY_MS = 100;

export const appleDevicePlatformSchema = z.enum([
  "ios",
  "ipados",
  "macos",
  "watchos",
  "tvos",
  "visionos",
  "unknown",
]);

export type AppleDevicePlatform = z.infer<typeof appleDevicePlatformSchema>;

export const appleAdapterAccountMetadataSchema = z.object({
  accountId: z.string().min(1),
  displayName: z.string().min(1).nullable().optional(),
  primaryEmail: z.string().email().nullable().optional(),
  teamId: z.string().min(1).nullable().optional(),
  teamName: z.string().min(1).nullable().optional(),
  region: z.string().min(1).nullable().optional(),
  fetchedAt: z.string().datetime(),
});

export type AppleAdapterAccountMetadata = z.infer<typeof appleAdapterAccountMetadataSchema>;

export const appleAdapterDeviceMetadataSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1),
  platform: appleDevicePlatformSchema,
  model: z.string().min(1).nullable().optional(),
  osVersion: z.string().min(1).nullable().optional(),
  serialNumberLast4: z.string().regex(/^[A-Za-z0-9]{4}$/).nullable().optional(),
  lastSeenAt: z.string().datetime().nullable().optional(),
  fetchedAt: z.string().datetime(),
});

export type AppleAdapterDeviceMetadata = z.infer<typeof appleAdapterDeviceMetadataSchema>;

export const appleAdapterLookupInputSchema = z.object({
  companyId: z.string().min(1),
  accountRef: z.string().min(1).nullable().optional(),
});

export type AppleAdapterLookupInput = z.infer<typeof appleAdapterLookupInputSchema>;

export const appleAdapterRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(APPLE_ADAPTER_DEFAULT_MAX_ATTEMPTS),
  baseDelayMs: z.number().int().min(0).default(APPLE_ADAPTER_DEFAULT_BASE_DELAY_MS),
});

export type AppleAdapterRetryPolicy = z.infer<typeof appleAdapterRetryPolicySchema>;

export const appleAdapterBoundaryOptionsSchema = z.object({
  timeoutMs: z.number().int().min(1).default(APPLE_ADAPTER_DEFAULT_TIMEOUT_MS),
  retry: appleAdapterRetryPolicySchema.default({
    maxAttempts: APPLE_ADAPTER_DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: APPLE_ADAPTER_DEFAULT_BASE_DELAY_MS,
  }),
});

export type AppleAdapterBoundaryOptions = z.input<typeof appleAdapterBoundaryOptionsSchema>;
export type ResolvedAppleAdapterBoundaryOptions = z.output<typeof appleAdapterBoundaryOptionsSchema>;

