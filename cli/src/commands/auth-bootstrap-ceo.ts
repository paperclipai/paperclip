import { createHash, randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDb, instanceUserRoles, invites } from "@paperclipai/db";
import { inferBindModeFromHost } from "@paperclipai/shared";
import { loadPaperclipEnvFile } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createInviteToken() {
  return `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
}

function resolveDbUrl(configPath?: string, explicitDbUrl?: string) {
  if (explicitDbUrl) return explicitDbUrl;
  const config = readConfig(configPath);
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (config?.database.mode === "postgres" && config.database.connectionString) {
    return config.database.connectionString;
  }
  if (config?.database.mode === "embedded-postgres") {
    const port = config.database.embeddedPostgresPort ?? 54329;
    return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  }
  return null;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function normalizeServerBaseUrl(value: string) {
  return normalizeBaseUrl(value).replace(/\/api$/, "");
}

function resolveBaseUrl(
  config: ReturnType<typeof readConfig>,
  explicitBaseUrl?: string,
  fallbackBaseUrl?: string,
) {
  if (explicitBaseUrl?.trim()) return normalizeBaseUrl(explicitBaseUrl);
  const fromEnv =
    process.env.PAPERCLIP_PUBLIC_URL ??
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL;
  if (fromEnv?.trim()) return normalizeBaseUrl(fromEnv);
  if (config?.auth.baseUrlMode === "explicit" && config.auth.publicBaseUrl) {
    return normalizeBaseUrl(config.auth.publicBaseUrl);
  }
  if (fallbackBaseUrl?.trim()) return normalizeServerBaseUrl(fallbackBaseUrl);
  const bind = config?.server.bind ?? inferBindModeFromHost(config?.server.host);
  const host =
    bind === "custom"
      ? config?.server.customBindHost ?? config?.server.host ?? "localhost"
      : config?.server.host ?? "localhost";
  const isLanWildcard = bind === "lan" || host === "0.0.0.0" || host === "::";
  const allowedHostname = config?.server.allowedHostnames.find((value) => value.trim().length > 0);
  if (isLanWildcard && allowedHostname) {
    return `http://${allowedHostname.trim()}:${config?.server.port ?? 3100}`;
  }
  const port = config?.server.port ?? 3100;
  const publicHost = host === "0.0.0.0" || host === "::" || bind === "lan" ? "localhost" : host;
  return `http://${publicHost}:${port}`;
}

export async function bootstrapCeoInvite(opts: {
  config?: string;
  force?: boolean;
  expiresHours?: number;
  baseUrl?: string;
  dbUrl?: string;
  fallbackBaseUrl?: string;
  rotate?: boolean;
}) {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const config = readConfig(configPath);
  if (!config) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("paperclip onboard")} first.`);
    return;
  }

  if (config.server.deploymentMode !== "authenticated") {
    p.log.info("Deployment mode is local_trusted. Bootstrap CEO invite is only required for authenticated mode.");
    return;
  }

  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error(
      "Could not resolve database connection for bootstrap.",
    );
    return;
  }

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: {
      end?: (options?: { timeout?: number }) => Promise<void>;
    };
  };
  try {
    const existingAdminCount = await db
      .select()
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"))
      .then((rows) => rows.length);

    if (existingAdminCount > 0 && !opts.force) {
      p.log.info("Instance already has an admin user. Use --force to generate a new bootstrap invite.");
      return;
    }

    const now = new Date();
    const activeBootstrapInvite = and(
      eq(invites.inviteType, "bootstrap_ceo"),
      isNull(invites.revokedAt),
      isNull(invites.acceptedAt),
      gt(invites.expiresAt, now),
    );
    if (opts.rotate === false) {
      const existingInvite = await db
        .select({ id: invites.id })
        .from(invites)
        .where(activeBootstrapInvite)
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingInvite) {
        p.log.info(
          `Bootstrap CEO invite is already pending. Run ${pc.cyan("paperclipai auth bootstrap-ceo")} to rotate it and print a new invite URL.`,
        );
        return;
      }
    } else {
      await db
        .update(invites)
        .set({ revokedAt: now, updatedAt: now })
        .where(activeBootstrapInvite);
    }

    const token = createInviteToken();
    const expiresHours = Math.max(1, Math.min(24 * 30, opts.expiresHours ?? 72));
    const created = await db
      .insert(invites)
      .values({
        inviteType: "bootstrap_ceo",
        tokenHash: hashToken(token),
        allowedJoinTypes: "human",
        expiresAt: new Date(Date.now() + expiresHours * 60 * 60 * 1000),
        invitedByUserId: "system",
      })
      .returning()
      .then((rows) => rows[0]);

    const baseUrl = resolveBaseUrl(config, opts.baseUrl, opts.fallbackBaseUrl);
    const inviteUrl = `${baseUrl}/invite/${token}`;
    p.log.success("Created bootstrap CEO invite.");
    if (process.env.PAPERCLIP_SERVICE_MANAGED === "1") {
      p.log.message(
        `Bootstrap pending: run ${pc.cyan("paperclipai auth bootstrap-ceo")} to get an invite URL.`,
      );
      return;
    }
    p.log.message(`Invite URL: ${pc.cyan(inviteUrl)}`);
    p.log.message(`Expires: ${pc.dim(created.expiresAt.toISOString())}`);
  } catch (err) {
    p.log.error(`Could not create bootstrap invite: ${err instanceof Error ? err.message : String(err)}`);
    p.log.info("If using embedded-postgres, start the Paperclip server and run this command again.");
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
