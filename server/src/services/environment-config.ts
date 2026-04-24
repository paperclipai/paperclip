import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type {
  Environment,
  EnvironmentDriver,
  LocalEnvironmentConfig,
  SshEnvironmentConfig,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { secretService } from "./secrets.js";

const secretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional().default("latest"),
}).strict();

const sshEnvironmentConfigSchema = z.object({
  host: z.string({ required_error: "SSH environments require a host." }).trim().min(1, "SSH environments require a host."),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string({ required_error: "SSH environments require a username." }).trim().min(1, "SSH environments require a username."),
  remoteWorkspacePath: z
    .string({ required_error: "SSH environments require a remote workspace path." })
    .trim()
    .min(1, "SSH environments require a remote workspace path.")
    .refine((value) => value.startsWith("/"), "SSH remote workspace path must be absolute."),
  privateKey: z.null().optional().default(null),
  privateKeySecretRef: secretRefSchema.optional().nullable().default(null),
  knownHosts: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((value) => (value && value.length > 0 ? value : null)),
  strictHostKeyChecking: z.boolean().optional().default(true),
}).strict();

const sshEnvironmentConfigProbeSchema = sshEnvironmentConfigSchema.extend({
  privateKey: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((value) => (value && value.length > 0 ? value : null)),
}).strict();

const sshEnvironmentConfigPersistenceSchema = sshEnvironmentConfigProbeSchema;

export type ParsedEnvironmentConfig =
  | { driver: "local"; config: LocalEnvironmentConfig }
  | { driver: "ssh"; config: SshEnvironmentConfig };

function toErrorMessage(error: z.ZodError) {
  const first = error.issues[0];
  if (!first) return "Invalid environment config.";
  return first.message;
}

function secretName(input: {
  environmentName: string;
  driver: EnvironmentDriver;
  field: string;
}) {
  const slug = input.environmentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "environment";
  return `environment-${input.driver}-${slug}-${input.field}-${randomUUID().slice(0, 8)}`;
}

async function createEnvironmentSecret(input: {
  db: Db;
  companyId: string;
  environmentName: string;
  driver: EnvironmentDriver;
  field: string;
  value: string;
  actor?: { userId?: string | null; agentId?: string | null };
}) {
  const created = await secretService(input.db).create(
    input.companyId,
    {
      name: secretName(input),
      provider: "local_encrypted",
      value: input.value,
      description: `Secret for ${input.environmentName} ${input.field}.`,
    },
    input.actor,
  );
  return {
    type: "secret_ref" as const,
    secretId: created.id,
    version: "latest" as const,
  };
}

export function normalizeEnvironmentConfig(input: {
  driver: EnvironmentDriver;
  config: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  if (input.driver === "local") {
    return { ...parseObject(input.config) };
  }

  if (input.driver === "ssh") {
    const parsed = sshEnvironmentConfigSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data satisfies SshEnvironmentConfig;
  }

  throw unprocessable(`Unsupported environment driver "${input.driver}".`);
}

export function normalizeEnvironmentConfigForProbe(input: {
  driver: EnvironmentDriver;
  config: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  if (input.driver === "ssh") {
    const parsed = sshEnvironmentConfigProbeSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data satisfies SshEnvironmentConfig;
  }

  return normalizeEnvironmentConfig(input);
}

export async function normalizeEnvironmentConfigForPersistence(input: {
  db: Db;
  companyId: string;
  environmentName: string;
  driver: EnvironmentDriver;
  config: Record<string, unknown> | null | undefined;
  actor?: { userId?: string | null; agentId?: string | null };
}): Promise<Record<string, unknown>> {
  if (input.driver === "ssh") {
    const parsed = sshEnvironmentConfigPersistenceSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    const secrets = secretService(input.db);
    const { privateKey, ...stored } = parsed.data;
    let nextPrivateKeySecretRef = stored.privateKeySecretRef;
    if (privateKey) {
      nextPrivateKeySecretRef = await createEnvironmentSecret({
        db: input.db,
        companyId: input.companyId,
        environmentName: input.environmentName,
        driver: input.driver,
        field: "private-key",
        value: privateKey,
        actor: input.actor,
      });
      if (
        stored.privateKeySecretRef &&
        stored.privateKeySecretRef.secretId !== nextPrivateKeySecretRef.secretId
      ) {
        await secrets.remove(stored.privateKeySecretRef.secretId);
      }
    }
    return {
      ...stored,
      privateKey: null,
      privateKeySecretRef: nextPrivateKeySecretRef,
    } satisfies SshEnvironmentConfig;
  }

  return normalizeEnvironmentConfig({
    driver: input.driver,
    config: input.config,
  });
}

export async function resolveEnvironmentDriverConfigForRuntime(
  db: Db,
  companyId: string,
  environment: Pick<Environment, "driver" | "config">,
): Promise<ParsedEnvironmentConfig> {
  const parsed = parseEnvironmentDriverConfig(environment);
  if (parsed.driver === "ssh" && parsed.config.privateKeySecretRef) {
    return {
      driver: "ssh",
      config: {
        ...parsed.config,
        privateKey: await secretService(db).resolveSecretValue(
          companyId,
          parsed.config.privateKeySecretRef.secretId,
          parsed.config.privateKeySecretRef.version ?? "latest",
        ),
      },
    };
  }

  return parsed;
}

export function readSshEnvironmentPrivateKeySecretId(
  environment: Pick<Environment, "driver" | "config">,
): string | null {
  if (environment.driver !== "ssh") return null;
  const parsed = sshEnvironmentConfigSchema.safeParse(parseObject(environment.config));
  if (!parsed.success) return null;
  return parsed.data.privateKeySecretRef?.secretId ?? null;
}

export function parseEnvironmentDriverConfig(
  environment: Pick<Environment, "driver" | "config">,
): ParsedEnvironmentConfig {
  if (environment.driver === "local") {
    return {
      driver: "local",
      config: { ...parseObject(environment.config) },
    };
  }

  if (environment.driver === "ssh") {
    const parsed = sshEnvironmentConfigSchema.parse(parseObject(environment.config));
    return {
      driver: "ssh",
      config: parsed,
    };
  }

  throw new Error(`Unsupported environment driver "${environment.driver}".`);
}
