import { z } from "zod";
import {
  ENVIRONMENT_DRIVERS,
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_STATUSES,
  ENVIRONMENT_STATUSES,
} from "../constants.js";

export const environmentDriverSchema = z.enum(ENVIRONMENT_DRIVERS);
export const environmentStatusSchema = z.enum(ENVIRONMENT_STATUSES);
export const environmentLeaseStatusSchema = z.enum(ENVIRONMENT_LEASE_STATUSES);
export const environmentLeaseCleanupStatusSchema = z.enum(ENVIRONMENT_LEASE_CLEANUP_STATUSES);

// --- k8s driver config ---------------------------------------------------
// Validates `config` when `driver === "k8s"`. `.strict()` makes any unknown
// keys fail (e.g. inline `kubeconfig` — which we explicitly disallow in
// favour of `kubeconfigSecretRef`).

export const tolerationSchema = z.object({
  key: z.string().min(1),
  operator: z.enum(["Equal", "Exists"]).optional(),
  value: z.string().optional(),
  effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]).optional(),
});
export const tolerationsArraySchema = z.array(tolerationSchema);
export type Toleration = z.infer<typeof tolerationSchema>;

const k8sResourcesSchema = z
  .object({
    requests: z
      .object({ cpu: z.string().optional(), memory: z.string().optional() })
      .optional(),
    limits: z
      .object({ cpu: z.string().optional(), memory: z.string().optional() })
      .optional(),
  })
  .optional();

const providerPoolSchema = z.object({
  kind: z.literal("ccrotate"),
  accounts: z.array(z.string().email()).min(1),
});
export type ProviderPool = z.infer<typeof providerPoolSchema>;

export const k8sEnvironmentConfigSchema = z
  .object({
    kubeconfigSecretRef: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    workspaceVolumeClaim: z.string().min(1).optional(),
    workspaceMountPath: z.string().min(1).optional(),
    secretsNamespace: z.string().min(1).optional(),
    nodeSelector: z.record(z.string(), z.string()).optional(),
    tolerations: z.array(tolerationSchema).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    serviceAccountName: z.string().min(1).optional(),
    imagePullPolicy: z.enum(["Always", "IfNotPresent", "Never"]).optional(),
    resources: k8sResourcesSchema,
    // Empty `{}` is accepted (no constraint); populated pools restrict the
    // adapter's ccrotate rotation to the listed accounts.
    providers: z.record(z.string().min(1), providerPoolSchema).optional(),
  })
  .strict();
export type K8sEnvironmentConfig = z.infer<typeof k8sEnvironmentConfigSchema>;

// Per-driver config validators. Adding here lets `applyDriverConfigValidation`
// discriminate on `driver` while keeping the outer schema flat (preserving the
// API shape that the server route expects).
const driverConfigSchemas: Partial<
  Record<(typeof ENVIRONMENT_DRIVERS)[number], z.ZodTypeAny>
> = {
  k8s: k8sEnvironmentConfigSchema,
};

function applyDriverConfigValidation(
  ctx: z.RefinementCtx,
  driver: (typeof ENVIRONMENT_DRIVERS)[number] | undefined,
  config: unknown,
) {
  if (!driver) return;
  const driverSchema = driverConfigSchemas[driver];
  if (!driverSchema) return;
  // For PATCH semantics we only validate config when it's actually present.
  if (config === undefined) return;
  const parsed = driverSchema.safeParse(config);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: ["config", ...issue.path],
      });
    }
  }
}

const environmentFields = {
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema,
  status: environmentStatusSchema.optional().default("active"),
  config: z.record(z.string(), z.unknown()).optional().default({}),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
};

export const createEnvironmentSchema = z
  .object(environmentFields)
  .strict()
  .superRefine((value, ctx) => {
    applyDriverConfigValidation(ctx, value.driver, value.config);
  });
export type CreateEnvironment = z.infer<typeof createEnvironmentSchema>;

export const updateEnvironmentSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    driver: environmentDriverSchema.optional(),
    status: environmentStatusSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    applyDriverConfigValidation(ctx, value.driver, value.config);
  });
export type UpdateEnvironment = z.infer<typeof updateEnvironmentSchema>;

export const probeEnvironmentConfigSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    driver: environmentDriverSchema,
    config: z.record(z.string(), z.unknown()).optional().default({}),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    applyDriverConfigValidation(ctx, value.driver, value.config);
  });
export type ProbeEnvironmentConfig = z.infer<typeof probeEnvironmentConfigSchema>;
