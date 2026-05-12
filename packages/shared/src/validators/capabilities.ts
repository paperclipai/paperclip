import { z } from "zod";

const externalApiEntrySchema = z.object({
  name: z.string().min(1),
  env_key: z.string().min(1),
});

const capabilitiesReadsSchema = z.object({
  api_endpoints: z.array(z.string()).default([]),
  shared_files: z.array(z.string()).default([]),
  db_tables: z.array(z.string()).default([]),
  intelligence_fields: z.array(z.string()).default([]),
});

const capabilitiesWritesSchema = z.object({
  api_endpoints: z.array(z.string()).default([]),
  shared_files: z.array(z.string()).default([]),
  intelligence_fields: z.array(z.string()).default([]),
});

const capabilitiesTriggersSchema = z.object({
  heartbeat_interval_seconds: z.number().int().positive().nullable().default(null),
  wake_on_assignment: z.boolean().default(false),
  sqs_message_types: z.array(z.string()).default([]),
});

export const agentCapabilitiesSchema = z.object({
  reads: capabilitiesReadsSchema,
  writes: capabilitiesWritesSchema,
  external_apis_used: z.array(externalApiEntrySchema).default([]),
  triggers: capabilitiesTriggersSchema,
});

export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

/** Parse a capabilities string and return the structured value, or null if empty/null. */
export function parseCapabilities(raw: string | null | undefined): AgentCapabilities | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return agentCapabilitiesSchema.parse(parsed);
  } catch {
    return null;
  }
}

/** Validate a capabilities JSON string. Returns error message or null if valid. */
export function validateCapabilitiesString(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "capabilities must be valid JSON";
  }
  const result = agentCapabilitiesSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".") ?? "";
    return path ? `capabilities.${path}: ${first?.message}` : (first?.message ?? "invalid capabilities");
  }
  return null;
}
