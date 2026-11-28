import { z } from "zod";

export const openshellProviderConfigSchema = z.object({
  gatewayEndpoint: z
    .string()
    .min(1, "gatewayEndpoint is required")
    .describe("OpenShell gateway gRPC endpoint (host:port)"),
  useTls: z.boolean().default(true),
  allowInsecure: z.boolean().default(false),
  caCert: z.string().optional(),
  sandboxImage: z
    .string()
    .default("ghcr.io/nvidia/openshell-community/sandboxes/base:latest"),
  workspacePath: z.string().default("/workspace"),
  defaultPolicy: z.record(z.unknown()).optional(),
  gpu: z.boolean().default(false),
  gpuCount: z.number().int().min(1).default(1),
  timeoutSeconds: z.number().int().min(1).default(3600),
  labels: z.record(z.string()).default({}),
});

export type OpenShellProviderConfig = z.infer<
  typeof openshellProviderConfigSchema
>;

export function parseOpenShellProviderConfig(
  input: unknown
): OpenShellProviderConfig {
  return openshellProviderConfigSchema.parse(input);
}

export interface OpenShellLeaseMetadata {
  sandboxName: string;
  sandboxId: string;
  endpoint: string;
  phase: string;
  image: string;
}
