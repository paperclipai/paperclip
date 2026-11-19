import { describe, expect, it } from "vitest";
import { buildPgDumpInvocation } from "./backup-lib.js";

const PASSWORD = "p@ss/w:rd#tech7095";
const SENTINELS = {
  BETTER_AUTH_SECRET: "tech7095-better-auth-secret",
  PAPERCLIP_SECRETS_MASTER_KEY: "tech7095-master-key",
  ANTHROPIC_API_KEY: "sk-ant-tech7095",
  PAPERCLIP_SSO_PROVIDERS: "tech7095-sso",
  PGPASSWORD: "inherited-password-tech7095",
  PGSERVICE: "inherited-service",
};

describe("buildPgDumpInvocation (TECH-7095)", () => {
  const url = `postgres://dbuser:${encodeURIComponent(PASSWORD)}@db.internal:5433/paperclip?sslmode=require&application_name=backup`;

  it("keeps the credential out of argv and passes it via libpq env vars", () => {
    const { args, env, credentialInArgv } = buildPgDumpInvocation(url, 15, { PATH: "/usr/bin" });
    expect(credentialInArgv).toBe(false);
    expect(args.join(" ")).not.toContain(PASSWORD);
    expect(args.join(" ")).not.toContain("dbuser");
    expect(args.some((a) => a.startsWith("--dbname"))).toBe(false);
    expect(env).toMatchObject({
      PGHOST: "db.internal",
      PGPORT: "5433",
      PGUSER: "dbuser",
      PGPASSWORD: PASSWORD,
      PGDATABASE: "paperclip",
      PGSSLMODE: "require",
      PGAPPNAME: "backup",
      PGCONNECT_TIMEOUT: "15",
    });
  });

  it("does not forward the server's secrets or an inherited PGPASSWORD/PGSERVICE", () => {
    const { env } = buildPgDumpInvocation(url, 15, { PATH: "/usr/bin", HOME: "/h", ...SENTINELS });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.PAPERCLIP_SECRETS_MASTER_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PAPERCLIP_SSO_PROVIDERS).toBeUndefined();
    expect(env.PGSERVICE).toBeUndefined();
    expect(env.PGPASSWORD).toBe(PASSWORD); // the URL's, never the inherited one
    for (const value of Object.values(SENTINELS)) {
      if (value === SENTINELS.PGPASSWORD) continue;
      expect(JSON.stringify(env)).not.toContain(value);
    }
  });

  it("keeps operator libpq settings such as PGSSLROOTCERT", () => {
    const { env } = buildPgDumpInvocation(url, 15, { PGSSLROOTCERT: "/etc/ca.pem" });
    expect(env.PGSSLROOTCERT).toBe("/etc/ca.pem");
  });

  it("handles an IPv6 host and a URL without credentials or database", () => {
    const { env } = buildPgDumpInvocation("postgres://[::1]:5432/", 5, {});
    expect(env.PGHOST).toBe("::1");
    expect(env.PGPORT).toBe("5432");
    expect(env.PGUSER).toBeUndefined();
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.PGDATABASE).toBeUndefined();
  });

  it("falls back to --dbname (flagged) for a URL parameter it cannot map, instead of dropping it", () => {
    const odd = "postgres://u:p@h/db?target_session_attrs=read-write";
    const { args, credentialInArgv } = buildPgDumpInvocation(odd, 5, {});
    expect(credentialInArgv).toBe(true);
    expect(args[0]).toBe(`--dbname=${odd}`);
  });

  it("falls back for a non-postgres string", () => {
    const { args, credentialInArgv } = buildPgDumpInvocation("host=localhost dbname=x", 5, {});
    expect(credentialInArgv).toBe(true);
    expect(args[0]).toBe("--dbname=host=localhost dbname=x");
  });

  it("forwards only an explicit list of libpq tuning variables, not any PG-prefixed variable", () => {
    const { env } = buildPgDumpInvocation(url, 15, {
      PGHOSTADDR: "203.0.113.9",
      PG_ADMIN_TOKEN: "tech7095-pg-admin-token",
      PG_ENCRYPTION_KEY: "tech7095-pg-enc-key",
      PGPASSFILE: "/x/.pgpass",
      PGUSER: "inherited-user",
      PGSSLROOTCERT: "/etc/ca.pem",
      PGOPTIONS: "-c statement_timeout=0",
    });
    expect(env.PGHOSTADDR).toBeUndefined();
    expect(env.PG_ADMIN_TOKEN).toBeUndefined();
    expect(env.PG_ENCRYPTION_KEY).toBeUndefined();
    expect(env.PGPASSFILE).toBeUndefined();
    expect(env.PGUSER).toBe("dbuser"); // from the URL, not the inherited value
    expect(env.PGSSLROOTCERT).toBe("/etc/ca.pem");
    expect(env.PGOPTIONS).toBe("-c statement_timeout=0");
  });

  it("decodes a percent-encoded Unix-socket host and maps the host query parameter", () => {
    expect(buildPgDumpInvocation("postgresql://%2Fvar%2Frun%2Fpostgresql/paperclip", 5, {}).env.PGHOST).toBe("/var/run/postgresql");
    const viaQuery = buildPgDumpInvocation("postgres:///paperclip?host=/var/run/postgresql", 5, {});
    expect(viaQuery.credentialInArgv).toBe(false);
    expect(viaQuery.env.PGHOST).toBe("/var/run/postgresql");
    expect(viaQuery.env.PGDATABASE).toBe("paperclip");
  });

  it("keeps the operator's TLS posture: PGSSLMODE passes through, and a URL sslmode overrides it", () => {
    const noUrlMode = buildPgDumpInvocation("postgres://u:p@h/db", 5, { PGSSLMODE: "verify-full", PGCHANNELBINDING: "require", PGSSLCERTMODE: "require" });
    expect(noUrlMode.env.PGSSLMODE).toBe("verify-full");
    expect(noUrlMode.env.PGCHANNELBINDING).toBe("require");
    expect(noUrlMode.env.PGSSLCERTMODE).toBe("require");
    const urlMode = buildPgDumpInvocation("postgres://u:p@h/db?sslmode=require", 5, { PGSSLMODE: "disable" });
    expect(urlMode.env.PGSSLMODE).toBe("require");
  });

  it("never falls back to argv because of a malformed percent-escape in a mappable URL", () => {
    for (const odd of ["postgres://user:p%zzw@h/db", "postgres://us%er:pw@h/db", "postgres://u:pw@h%zz/db", "postgres://u:pw@h/d%b"]) {
      const { args, env, credentialInArgv } = buildPgDumpInvocation(odd, 5, {});
      expect(credentialInArgv, odd).toBe(false);
      expect(args.some((a) => a.startsWith("--dbname")), odd).toBe(false);
      expect(JSON.stringify(args), odd).not.toMatch(/pw|p%zzw/);
      expect(env.PGPASSWORD, odd).toBeDefined();
    }
    // Raw (undecoded) text is passed through as written.
    expect(buildPgDumpInvocation("postgres://user:p%zzw@h/db", 5, {}).env.PGPASSWORD).toBe("p%zzw");
    expect(buildPgDumpInvocation("postgres://us%er:pw@h/db", 5, {}).env.PGUSER).toBe("us%er");
  });
});

describe("buildPgDumpInvocation row security (TECH-9120)", () => {
  it("asks pg_dump to read under the role's RLS visibility so a non-bypass role does not fail", () => {
    // Without this flag pg_dump runs with row_security=off and exits 1 with "query would be affected by
    // row-level security policy" for a role that is not superuser/BYPASSRLS, which silently sent the
    // production backup to the in-process engine.
    const mapped = buildPgDumpInvocation("postgres://u:p@db.internal:5432/paperclip", 5, {});
    expect(mapped.args).toContain("--enable-row-security");
    // Also on the argv fallback path used for URLs with unmappable parameters.
    const argvFallback = buildPgDumpInvocation("postgres://u:p@db.internal:5432/paperclip?unmappable=1", 5, {});
    expect(argvFallback.credentialInArgv).toBe(true);
    expect(argvFallback.args).toContain("--enable-row-security");
  });
});
