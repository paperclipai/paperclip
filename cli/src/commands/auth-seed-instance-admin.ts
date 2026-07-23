import * as p from "@clack/prompts";
import pc from "picocolors";
import { createDb, authUsers, instanceUserRoles } from "@paperclipai/db";
import { resolveDbUrl } from "../config/db.js";
import { loadPaperclipEnvFile } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

const DEFAULT_SEED_ADMIN_USER_ID = "platform-admin";
const DEFAULT_SEED_ADMIN_EMAIL = "platform-admin@paperclip.local";
const DEFAULT_SEED_ADMIN_NAME = "Platform Admin";

const INSTANCE_ADMIN_ROLE = "instance_admin";

export interface SeedInstanceAdminPrincipal {
  userId: string;
  email: string;
  name: string;
}

export interface EnsureInstanceAdminResult {
  /** True when a brand new authUsers row was inserted. */
  createdUser: boolean;
  /** True when a brand new instance_admin role row was inserted. */
  createdRole: boolean;
}

/**
 * Resolve the seed principal from environment variables, falling back to
 * stable defaults so automation (Helm hooks, Terraform provisioners, CI
 * pipelines) can run the command with zero extra configuration.
 */
export function resolveSeedPrincipal(
  env: NodeJS.ProcessEnv = process.env,
): SeedInstanceAdminPrincipal {
  const userId = env.PAPERCLIP_SEED_ADMIN_USER_ID?.trim() || DEFAULT_SEED_ADMIN_USER_ID;
  const email = env.PAPERCLIP_SEED_ADMIN_EMAIL?.trim() || DEFAULT_SEED_ADMIN_EMAIL;
  const name = env.PAPERCLIP_SEED_ADMIN_NAME?.trim() || DEFAULT_SEED_ADMIN_NAME;
  return { userId, email, name };
}

/**
 * Idempotently ensure that an authUsers row and an instance_admin
 * instanceUserRoles row exist for the given principal.
 *
 * Mirrors the upsert pattern in server/src/index.ts:ensureLocalTrustedBoardPrincipal.
 * Both inserts use ON CONFLICT DO NOTHING so the writes are idempotent at the
 * DB level, not just at the read/check level. This makes the seed safe to run
 * concurrently from multiple automation processes (e.g. init containers of
 * several replicas, or a retried Helm hook racing an earlier attempt): the
 * racers yield exactly one admin and one role row, and neither insert throws
 * on a concurrent duplicate.
 *
 * The createdUser/createdRole flags come from RETURNING on the conflict-safe
 * inserts, so they are exact even under concurrency: only the process whose
 * insert actually landed reports created=true; a racer whose insert was a
 * conflict no-op gets zero rows back and reports created=false.
 *
 * Does NOT create company memberships: instance_admin bypasses company
 * scoping via authz, so no membership rows are required.
 */
export async function ensureInstanceAdmin(
  db: {
    select: (...args: any[]) => any;
    insert: (...args: any[]) => any;
  },
  principal: SeedInstanceAdminPrincipal,
): Promise<EnsureInstanceAdminResult> {
  const now = new Date();

  // ON CONFLICT DO NOTHING on the primary key keeps this race-safe when
  // several automation processes (e.g. per-replica init containers) run the
  // seed concurrently: a duplicate insert is a no-op instead of a
  // duplicate-key error that would fail the run. RETURNING yields the row
  // only when this call actually inserted it.
  const insertedUsers: Array<{ id: string }> = await db
    .insert(authUsers)
    .values({
      id: principal.userId,
      name: principal.name,
      email: principal.email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: authUsers.id })
    .returning({ id: authUsers.id });
  const createdUser = insertedUsers.length > 0;

  // ON CONFLICT DO NOTHING on the unique (user_id, role) index
  // (instance_user_roles_user_role_unique_idx) keeps concurrent seeds from
  // racing on the same role row and failing the run.
  const insertedRoles: Array<{ id: string }> = await db
    .insert(instanceUserRoles)
    .values({
      userId: principal.userId,
      role: INSTANCE_ADMIN_ROLE,
    })
    .onConflictDoNothing({
      target: [instanceUserRoles.userId, instanceUserRoles.role],
    })
    .returning({ id: instanceUserRoles.id });
  const createdRole = insertedRoles.length > 0;

  return { createdUser, createdRole };
}

export async function seedInstanceAdmin(opts: {
  config?: string;
  dbUrl?: string;
}): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);

  // Mirror auth-bootstrap-ceo: seeding an instance admin only applies to
  // authenticated deployments — local_trusted instances auto-seed their own
  // board principal at server startup. Only enforceable when a config file is
  // readable; headless automation that points straight at the DB via
  // --db-url/DATABASE_URL (no config on the seeding host) proceeds as before.
  const config = readConfig(configPath);
  if (config && config.server.deploymentMode !== "authenticated") {
    p.log.info(
      "Deployment mode is local_trusted. Seeding an instance admin is only required for authenticated mode; the server auto-seeds a local board principal.",
    );
    return;
  }

  const principal = resolveSeedPrincipal();

  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error(
      `Could not resolve database connection. Set ${pc.cyan("DATABASE_URL")} or pass ${pc.cyan("--db-url")}.`,
    );
    process.exitCode = 1;
    return;
  }

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: {
      end?: (options?: { timeout?: number }) => Promise<void>;
    };
  };
  try {
    const result = await ensureInstanceAdmin(db, principal);

    if (result.createdRole) {
      p.log.success(
        `Seeded instance admin ${pc.cyan(principal.userId)} (${pc.dim(principal.email)}).`,
      );
    } else {
      p.log.info(
        `Instance admin ${pc.cyan(principal.userId)} already present. No changes made.`,
      );
    }
  } catch (err) {
    p.log.error(
      `Could not seed instance admin: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
