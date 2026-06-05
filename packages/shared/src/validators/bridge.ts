import { z } from "zod";

export const bridgeSourceSchema = z.enum([
  "bridge-shell",
  "bridge-write",
  "bridge-url",
  "bridge-read",
]);

export const bridgeCapabilitySchema = z.object({
  source: bridgeSourceSchema,
  scope: z.string(),
  lastUsedAt: z.number(),
  count: z.number().int().nonnegative(),
});

export const bridgeSessionPayloadSchema = z.union([
  z.null(),
  z.object({
    jti: z.string(),
    iat: z.number(),
    exp: z.number(),
    capabilityCount: z.number().int().nonnegative(),
    capabilities: z.array(bridgeCapabilitySchema),
  }),
]);

export const bridgeDenyFlashPayloadSchema = z.object({
  jti: z.string(),
  source: bridgeSourceSchema,
  scope: z.string(),
  ts: z.number(),
});

export type BridgeSource = z.infer<typeof bridgeSourceSchema>;
export type BridgeCapability = z.infer<typeof bridgeCapabilitySchema>;
export type BridgeSessionPayload = z.infer<typeof bridgeSessionPayloadSchema>;
export type BridgeDenyFlashPayload = z.infer<typeof bridgeDenyFlashPayloadSchema>;
