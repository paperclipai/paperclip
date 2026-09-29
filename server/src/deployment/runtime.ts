import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { paperclipConfigSchema, deploymentManifestSchema } from "@paperclipai/shared";
import { readDeploymentCredential as readCredential } from "./credentials.js";
export { readDeploymentCredential as readCredential } from "./credentials.js";

export const runtimeFile = z.string().refine((p) => isAbsolute(p) && normalize(p) === p
  && p !== "/" && !p.startsWith("/nix/store/"), "Expected an absolute runtime file outside the Nix store");
export const deploymentDescriptorSchema = z.object({
  version: z.literal(1),
  home: runtimeFile,
  instance: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/),
  executionProfile: z.enum(["trusted-local", "remote-only"]).optional(),
  configFile: z.string(),
  manifestFile: z.string().optional(),
  credentialFiles: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/), runtimeFile).default({}),
  serverCredentials: z.object({
    auth: runtimeFile.optional(),
    database: runtimeFile.optional(),
    migration: runtimeFile.optional(),
    encryption: runtimeFile.optional(),
  }).strict().default({}),
  embedded: z.object({
    user: z.string().regex(/^[a-z_][a-z0-9_-]{0,62}$/),
    database: z.string().regex(/^[a-z_][a-z0-9_-]{0,62}$/),
    passwordFile: runtimeFile,
  }).strict().optional(),
  bootstrap: z.object({ email: z.string().email(), name: z.string().min(1), passwordFile: runtimeFile }).strict().optional(),
}).strict();
export type DeploymentDescriptor = z.infer<typeof deploymentDescriptorSchema>;

export class UnqualifiedRemoteExecutionError extends Error {
  constructor() {
    super("Paperclip remote-only execution is not yet qualified; refusing startup before adapter/plugin loading or database mutation.");
  }
}

// Server credentials live in this process, never in the inherited environment.
let serverCredentials: Partial<Record<"auth" | "database" | "migration", string>> = {};
export function deploymentServerCredential(name: keyof typeof serverCredentials) {
  return process.env.PAPERCLIP_DECLARATIVE === "true" ? serverCredentials[name] : undefined;
}

export function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Deployment JSON could not be read or parsed"); }
}

// Walk the upstream schema, including defaults, rather than maintaining another
// list of configuration keys. Upstream's interactive editor preserves extension
// keys; declarative configuration must instead reject them until supported.
function rejectUnknown(value: unknown, schema: z.ZodType, path: string[] = []): void {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodPrefault) {
    current = current.unwrap() as z.ZodType;
  }
  if (!(current instanceof z.ZodObject) || !value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childSchema = current.shape[key];
    if (!childSchema) throw new Error(`Unsupported deployment config field: ${[...path, key].join(".")}`);
    rejectUnknown(child, childSchema, [...path, key]);
  }
}

export function validateDeploymentConfig(raw: unknown) {
  rejectUnknown(raw, paperclipConfigSchema);
  const parsed = paperclipConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid deployment application configuration");
  return parsed.data;
}

export function loadDeploymentDescriptor(file: string): DeploymentDescriptor {
  const parsed = deploymentDescriptorSchema.safeParse(readJson(file));
  if (!parsed.success) throw new Error("Invalid deployment descriptor");
  const descriptor = parsed.data;
  // The shared dispatch path still prepares controller-local workspaces and
  // runtime tools before invoking HTTP gateways. Do not advertise containment
  // by merely filtering adapter names. The profile stays closed until those
  // paths and plugin/stdio loading have end-to-end enforcement and VM evidence.
  if (descriptor.executionProfile === "remote-only") throw new UnqualifiedRemoteExecutionError();
  const config = validateDeploymentConfig(readJson(descriptor.configFile));
  if (config.database.connectionString) throw new Error("Database connections must use runtime credential files");
  if (descriptor.manifestFile && !deploymentManifestSchema.safeParse(readJson(descriptor.manifestFile)).success) {
    throw new Error("Invalid deployment manifest");
  }
  if (!descriptor.serverCredentials.auth) {
    throw new Error("Deployment requires a signing credential for authentication and scoped agent tokens");
  }
  if (config.database.mode === "postgres" && !descriptor.serverCredentials.database) {
    throw new Error("External PostgreSQL requires a database credential file");
  }
  if (config.database.mode === "embedded-postgres" && !descriptor.embedded) {
    throw new Error("Embedded deployment requires a database identity and password file");
  }
  return descriptor;
}

export function embeddedDeploymentIdentity() {
  const file = process.env.PAPERCLIP_DEPLOYMENT_FILE;
  const embedded = file ? loadDeploymentDescriptor(file).embedded : undefined;
  const user = embedded?.user ?? "paperclip";
  const database = embedded?.database ?? "paperclip";
  const password = embedded ? readCredential(embedded.passwordFile).trimEnd() : "paperclip";
  if (embedded && password.length < 16) throw new Error("Embedded database password requires at least 16 characters");
  return { user, database, password,
    url: (port: number, db = database) => `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(db)}` };
}

export function deploymentEnvironment(d: DeploymentDescriptor, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "XDG_RUNTIME_DIR", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE"]) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  Object.assign(env, {
    NODE_ENV: "production", PAPERCLIP_HOME: d.home, PAPERCLIP_INSTANCE_ID: d.instance,
    PAPERCLIP_CONFIG: d.configFile, PAPERCLIP_DECLARATIVE: "true",
    PAPERCLIP_MIGRATION_PROMPT: "never", PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
  });
  serverCredentials = {};
  for (const name of ["auth", "database", "migration"] as const) {
    const file = d.serverCredentials[name];
    if (file) serverCredentials[name] = readCredential(file).trimEnd();
  }
  if (serverCredentials.auth && serverCredentials.auth.length < 32) throw new Error("Authentication signing secret must contain at least 32 characters");
  if (d.serverCredentials.encryption) {
    readCredential(d.serverCredentials.encryption);
    env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = d.serverCredentials.encryption;
  }
  return env;
}
