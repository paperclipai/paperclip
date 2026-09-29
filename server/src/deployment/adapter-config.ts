import { z } from "zod";

// Execution contracts, deliberately independent of UI form schemas. Keep this
// closed until an adapter's consumed fields and credential projection are audited.
const text = z.string().min(1);
const duration = z.number().finite().nonnegative();
const url = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
});
const headers = z.record(z.string(), z.string()).refine((value) =>
  Object.keys(value).every((key) => !/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(key)),
);
const env = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string());
const schemas: Record<string, z.ZodType> = {
  process: z.object({
    command: text, args: z.array(z.string()).optional(), cwd: text.optional(),
    env: env.optional(), timeoutSec: duration.optional(), graceSec: duration.optional(),
  }).strict(),
  http: z.object({
    url, method: z.enum(["POST", "PUT", "PATCH"]).optional(), headers: headers.optional(),
    payloadTemplate: z.record(z.string(), z.json()).optional(), timeoutMs: duration.optional(),
  }).strict(),
  hermes_gateway: z.object({
    apiBaseUrl: url, paperclipApiUrl: url.optional(),
    dangerouslyAllowInsecureRemoteHttp: z.boolean().optional(),
    sessionKeyStrategy: z.enum(["issue", "agent", "run", "none"]).optional(),
    timeoutSec: duration.optional(), eventReconnectMs: duration.optional(), pollIntervalMs: duration.optional(),
    headers: headers.optional(), instructions: z.string().optional(),
    payloadTemplate: z.record(z.string(), z.json()).optional(),
  }).strict(),
};

export function validateDeclaredAdapterConfig(
  type: string, config: Record<string, unknown>, credentials: Record<string, string>,
): void {
  const schema = Object.hasOwn(schemas, type) ? schemas[type] : undefined;
  if (!schema) throw new Error("Adapter has no native deployment configuration contract");
  if (!schema.safeParse(config).success) throw new Error("Invalid declared adapter configuration");
  for (const field of Object.keys(credentials)) {
    if (type === "hermes_gateway" && field === "apiKey") continue;
    if (type !== "process" || !/^env\.[A-Z_][A-Z0-9_]*$/.test(field)
      || /^(PAPERCLIP_|DATABASE_|BETTER_AUTH_|NODE_OPTIONS$|LD_)/.test(field.slice(4))) {
      throw new Error("Unsupported or reserved adapter credential binding");
    }
    if (Object.hasOwn(config.env as Record<string, unknown> ?? {}, field.slice(4))) {
      throw new Error("Conflicting adapter credential binding");
    }
  }
  if (type === "hermes_gateway" && !Object.hasOwn(credentials, "apiKey")) {
    throw new Error("Hermes gateway requires a runtime apiKey credential binding");
  }
}
