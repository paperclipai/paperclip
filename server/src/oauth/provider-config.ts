import { z } from "zod";

const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), {
  message: "endpoint must use https://",
});

export const OAuthProviderConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1),
  iconUrl: z.string().url().optional(),
  docUrl: z.string().url().optional(),

  clientCredentials: z.object({
    clientIdEnv: z.string().min(1),
    clientSecretEnv: z.string().min(1),
  }),

  endpoints: z.object({
    authorize: httpsUrl,
    token: httpsUrl,
    revoke: httpsUrl.optional(),
    accountInfo: httpsUrl,
  }),

  scopes: z
    .object({
      default: z.array(z.string()),
      offered: z.array(z.string()),
    })
    .refine((s) => s.default.every((d) => s.offered.includes(d)), {
      message: "scopes.default must be a subset of scopes.offered",
    }),

  pkce: z.enum(["required", "optional", "unsupported"]),
  authMethod: z.enum(["post", "basic"]),
  responseFormat: z.enum(["json", "form"]),
  accountIdField: z.string().min(1),
  accountLabelField: z.string().min(1),

  refresh: z.discriminatedUnion("supported", [
    z.object({ supported: z.literal(false) }),
    z.object({
      supported: z.literal(true),
      rotatesRefreshToken: z.boolean(),
      expirySeconds: z.number().int().positive().optional(),
    }),
  ]),

  shape: z.string().optional(),
});

export type OAuthProviderConfig = z.infer<typeof OAuthProviderConfigSchema>;
