import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type {
  Environment,
  EnvironmentDriver,
  FakeSandboxEnvironmentConfig,
  LocalEnvironmentConfig,
  PluginSandboxEnvironmentConfig,
  PluginEnvironmentConfig,
  SandboxEnvironmentConfig,
  SshEnvironmentConfig,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { secretService } from "./secrets.js";
import { validatePluginEnvironmentDriverConfig } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

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

const fakeSandboxEnvironmentConfigSchema = z.object({
  provider: z.literal("fake").default("fake"),
  image: z
    .string()
    .trim()
    .min(1, "Fake sandbox environments require an image.")
    .default("ubuntu:24.04"),
  reuseLease: z.boolean().optional().default(false),
}).strict();

const pluginSandboxProviderKeySchema = z.string()
  .trim()
  .min(1, "Sandbox provider is required.")
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Sandbox provider key must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, hyphens, or underscores",
  )
  .refine((value) => value !== "fake", {
    message: "Built-in sandbox providers must use their dedicated config schema.",
  });

const pluginSandboxEnvironmentConfigSchema = z.object({
  provider: pluginSandboxProviderKeySchema,
  timeoutMs: z.coerce.number().int().min(1).max(86_400_000).optional(),
  reuseLease: z.boolean().optional().default(false),
}).catchall(z.unknown());

type SandboxConfigSchemaMode = "stored" | "probe" | "persistence";

const pluginEnvironmentConfigSchema = z.object({
  pluginKey: z.string().min(1),
  driverKey: z.string().min(1).regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Environment driver key must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, hyphens, or underscores",
  ),
  driverConfig: z.record(z.unknown()).optional().default({}),
}).strict();

export type ParsedEnvironmentConfig =
  | { driver: "local"; config: LocalEnvironmentConfig }
  | { driver: "ssh"; config: SshEnvironmentConfig }
  | { driver: "sandbox"; config: SandboxEnvironmentConfig }
  | { driver: "plugin"; config: PluginEnvironmentConfig };

function toErrorMessage(error: z.ZodError) {
  const first = error.issues[0];
  if (!first) return "Invalid environment config.";
  return first.message;
}

function getSandboxProvider(raw: Record<string, unknown>) {
  return typeof raw.provider === "string" && raw.provider.trim().length > 0 ? raw.provider.trim() : "fake";
}

function parseSandboxEnvironmentConfig(
  input: Record<string, unknown> | null | undefined,
  mode: SandboxConfigSchemaMode,
) {
  const raw = parseObject(input);
  const provider = getSandboxProvider(raw);

  if (provider === "fake") {
    const parsed = fakeSandboxEnvironmentConfigSchema.safeParse(raw);
    return parsed.success
      ? ({ success: true as const, data: parsed.data satisfies FakeSandboxEnvironmentConfig })
      : ({ success: false as const, error: parsed.error });
  }

  const parsed = pluginSandboxEnvironmentConfigSchema.safeParse(raw);
  return parsed.success
    ? ({ success: true as const, data: parsed.data satisfies PluginSandboxEnvironmentConfig })
    : ({ success: false as const, error: parsed.error });
}

const sshEnvironmentConfigProbeSchema = sshEnvironmentConfigSchema.extend({
  privateKey: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((value) => (value && value.length > 0 ? value : null)),
}).strict();

const sshEnvironmentConfigPersistenceSchema = sshEnvironmentConfigProbeSchema;

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

  if (input.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(input.config, "stored");
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  if (input.driver === "plugin") {
    const parsed = pluginEnvironmentConfigSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data satisfies PluginEnvironmentConfig;
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

  if (input.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(input.config, "probe");
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
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
  pluginWorkerManager?: PluginWorkerManager;
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

  if (input.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(input.config, "persistence");
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    const sandboxConfig = parsed.data;
    if (sandboxConfig.provider === "fake") {
      throw unprocessable(
        "Built-in fake sandbox environments are reserved for internal probes and cannot be saved.",
      );
    }
    return { ...(sandboxConfig as PluginSandboxEnvironmentConfig) };
  }

  if (input.driver === "plugin") {
    const parsed = pluginEnvironmentConfigSchema.safeParse(parseObject(input.config));
    if (!parsed.success) {
      throw unprocessable(toErrorMessage(parsed.error), {
        issues: parsed.error.issues,
      });
    }
    if (!input.pluginWorkerManager) {
      throw unprocessable("Plugin environment config validation requires a running plugin worker manager.");
    }
    return { ...(await validatePluginEnvironmentDriverConfig({
      db: input.db,
      workerManager: input.pluginWorkerManager,
      config: parsed.data,
    })) };
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
  const secrets = secretService(db);

  if (parsed.driver === "ssh" && parsed.config.privateKeySecretRef) {
    return {
      driver: "ssh",
      config: {
        ...parsed.config,
        privateKey: await secrets.resolveSecretValue(
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

  if (environment.driver === "sandbox") {
    const parsed = parseSandboxEnvironmentConfig(environment.config, "stored");
    if (!parsed.success) {
      throw parsed.error;
    }
    return {
      driver: "sandbox",
      config: parsed.data,
    };
  }

  if (environment.driver === "plugin") {
    const parsed = pluginEnvironmentConfigSchema.parse(parseObject(environment.config));
    return {
      driver: "plugin",
      config: parsed,
    };
  }

  throw new Error(`Unsupported environment driver "${environment.driver}".`);
}
