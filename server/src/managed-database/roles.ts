import { randomBytes } from "node:crypto";
import type postgres from "postgres";

export const TENANT_DATABASE = "paperclip";
export const OWNER_ROLE = "paperclip_owner";
export const APP_ROLE = "paperclip_app";
export const PLUGIN_ROLE = "paperclip_plugin";

export type ManagedRoleSecrets = {
  v: 1;
  supervisorPassword: string;
  ownerPassword: string;
};

export function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

type Sql = ReturnType<typeof postgres>;

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Cluster-level setup for a fresh cluster, run once as the bootstrap
 * superuser. The tenant database is owned by the schema-owner role; the app
 * and plugin roles receive only what `applyTenantGrants` gives them.
 */
export async function createClusterRoles(admin: Sql, secrets: ManagedRoleSecrets): Promise<void> {
  await admin.unsafe(`CREATE ROLE ${OWNER_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(secrets.ownerPassword)}`);
  await admin.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(generatePassword())}`);
  await admin.unsafe(`CREATE ROLE ${PLUGIN_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD ${literal(generatePassword())}`);
  // Plugin installs run core bookkeeping DML in the same transaction as the
  // plugin's namespace DDL, so the plugin role inherits the app's DML grants.
  await admin.unsafe(`GRANT ${APP_ROLE} TO ${PLUGIN_ROLE}`);
  await admin.unsafe(`CREATE DATABASE ${TENANT_DATABASE} OWNER ${OWNER_ROLE} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
  for (const database of ["postgres", "template1"]) {
    await admin.unsafe(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  }
}

/** New random runtime passwords at every supervisor start. */
export async function rotateTenantPasswords(admin: Sql): Promise<{ appPassword: string; pluginPassword: string }> {
  const appPassword = generatePassword();
  const pluginPassword = generatePassword();
  await admin.unsafe(`ALTER ROLE ${APP_ROLE} PASSWORD ${literal(appPassword)}`);
  await admin.unsafe(`ALTER ROLE ${PLUGIN_ROLE} PASSWORD ${literal(pluginPassword)}`);
  return { appPassword, pluginPassword };
}

/** Database-level privileges. Idempotent; reapplied after a restore swap. */
export async function applyDatabaseGrants(admin: Sql, database = TENANT_DATABASE): Promise<void> {
  await admin.unsafe(`ALTER DATABASE ${database} OWNER TO ${OWNER_ROLE}`);
  await admin.unsafe(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  await admin.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${APP_ROLE}`);
  await admin.unsafe(`GRANT CONNECT, CREATE ON DATABASE ${database} TO ${PLUGIN_ROLE}`);
}

/**
 * Plugin namespace guard. The plugin role holds CREATE on the database so a
 * plugin install can create its own schema, but it may only create or change
 * objects in `plugin_*` schemas. Ownership already keeps it away from core
 * objects; this closes arbitrary new schemas.
 */
const PLUGIN_GUARD_SQL = `
CREATE SCHEMA IF NOT EXISTS paperclip_managed AUTHORIZATION CURRENT_USER;
REVOKE CREATE ON SCHEMA paperclip_managed FROM PUBLIC;
GRANT USAGE ON SCHEMA paperclip_managed TO PUBLIC;
CREATE OR REPLACE FUNCTION paperclip_managed.enforce_plugin_ddl() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $guard$
DECLARE r record;
BEGIN
  IF session_user <> '${PLUGIN_ROLE}' THEN RETURN; END IF;
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF r.command_tag = 'CREATE SCHEMA' THEN
      IF r.object_identity !~ '^"?plugin_[A-Za-z0-9_]+"?$' THEN
        RAISE EXCEPTION 'managed database: % may only create plugin_* schemas (got %)', session_user, r.object_identity;
      END IF;
    ELSIF r.schema_name IS NULL OR r.schema_name !~ '^plugin_' THEN
      RAISE EXCEPTION 'managed database: % may only change plugin_* schemas (% %)', session_user, r.command_tag, r.object_identity;
    END IF;
  END LOOP;
END
$guard$;
REVOKE ALL ON FUNCTION paperclip_managed.enforce_plugin_ddl() FROM PUBLIC;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'paperclip_plugin_ddl_guard') THEN
    CREATE EVENT TRIGGER paperclip_plugin_ddl_guard ON ddl_command_end
      EXECUTE FUNCTION paperclip_managed.enforce_plugin_ddl();
  END IF;
END $do$;
`;

/**
 * Object-level privileges inside the tenant database, run as superuser.
 * Idempotent: applied at every start, after migrations, and after restores.
 *
 * - core schemas (owned by the owner role or pg_database_owner): app gets
 *   USAGE + table DML + sequence use; the migration journal is read-only
 * - plugin schemas (owned by the plugin role): app gets USAGE + DML
 * - default privileges cover objects created later by either owner
 * - the app and plugin roles never own core objects, so ALTER/DROP/TRUNCATE
 *   of core tables is impossible for them
 */
export async function applyTenantGrants(tenant: Sql): Promise<void> {
  await tenant.unsafe(PLUGIN_GUARD_SQL);
  await tenant.unsafe(`
DO $grants$
DECLARE s record;
BEGIN
  FOR s IN
    SELECT n.nspname, r.rolname AS owner
    FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname NOT IN ('information_schema', 'paperclip_managed')
  LOOP
    IF s.owner = '${PLUGIN_ROLE}' THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${APP_ROLE}', s.nspname);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO ${APP_ROLE}', s.nspname);
      EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO ${APP_ROLE}', s.nspname);
    ELSIF s.nspname = 'drizzle' THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${APP_ROLE}', s.nspname);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM ${APP_ROLE}', s.nspname);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO ${APP_ROLE}', s.nspname);
      EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO ${APP_ROLE}', s.nspname);
    ELSE
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', s.nspname);
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${APP_ROLE}', s.nspname);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO ${APP_ROLE}', s.nspname);
      EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO ${APP_ROLE}', s.nspname);
      EXECUTE format('GRANT REFERENCES ON ALL TABLES IN SCHEMA %I TO ${PLUGIN_ROLE}', s.nspname);
    END IF;
  END LOOP;
END
$grants$;
`);
  for (const owner of [OWNER_ROLE, PLUGIN_ROLE]) {
    await tenant.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`);
    await tenant.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${APP_ROLE}`);
  }
  await tenant.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${PLUGIN_ROLE} GRANT USAGE ON SCHEMAS TO ${APP_ROLE}`);
  await tenant.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} GRANT REFERENCES ON TABLES TO ${PLUGIN_ROLE}`);
}
