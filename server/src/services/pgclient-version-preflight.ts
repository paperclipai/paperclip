import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  raiseDatabaseBackupAlert,
  resolveDatabaseBackupAlert,
  type DatabaseBackupAlertBoard,
  type DatabaseBackupAlertLogger,
} from "./database-backup-alerts.js";

/**
 * SIN-70820 — control-plane pg_dump-client vs embedded-PostgreSQL major preflight.
 *
 * Anti-regression invariant behind SIN-70814 (3rd occurrence:
 * SIN-65200 → SIN-70116 → SIN-70814): every embedded-Postgres major bump that
 * is NOT matched by a host `postgresql-client` bump silently kills the automatic
 * backup — `pg_dump` refuses to dump a server whose major is newer than the
 * client (`server version mismatch`). The failure is quiet because the backup
 * scheduler swallows it; the outage stayed hidden for 9 days.
 *
 * This module resolves the two authoritative version sources and compares their
 * **majors**. On divergence it pushes a LOUD, idempotent signal through the
 * SIN-70819 board adapter (a distinct alert fingerprint so it dedups
 * independently of the backup-failure alert). It never hard-stops the boot —
 * the control-plane still comes up; it is the backup that is at risk.
 *
 * Hexagonal split (CTO lens): the comparison is pure, testable logic
 * (`comparePgMajor` + the two parsers). The IO — reading `<dataDir>/PG_VERSION`
 * and spawning `pg_dump --version` — is isolated behind injectable readers so
 * the tests need neither a real Postgres nor a real `pg_dump` binary.
 *
 * OWASP A09 / least privilege: only versions and the resolved binary path are
 * ever logged or written to the board. No connection string is touched here.
 */

/**
 * Stable alert fingerprint. Deliberately different from the backup-failure
 * fingerprint (`control-plane-backup-failure`) so the pg-client mismatch alert
 * is its own board issue and dedups on its own lifecycle, while still flowing
 * through the same SIN-70819 adapter/bridge.
 */
export const PGCLIENT_VERSION_ALERT_FINGERPRINT = "control-plane-pgclient-major-mismatch";

/**
 * Parse a Postgres major from a `pg_dump --version` line such as
 * `pg_dump (PostgreSQL) 18.1` or `pg_dump (PostgreSQL) 16.4 (Ubuntu 16.4-1.pgdg22.04+1)`.
 * Returns null when no major can be recovered.
 */
export function parsePgDumpVersionOutput(output: string): number | null {
  if (!output) return null;
  // Prefer the version token that follows the "PostgreSQL" product name, so a
  // package suffix like "(Ubuntu 16.4-1.pgdg22.04+1)" cannot win.
  const labelled = output.match(/PostgreSQL\)?\s+(\d+)(?:\.\d+)*/i);
  if (labelled) return Number.parseInt(labelled[1]!, 10);
  // Fallback: the first standalone integer that looks like a version.
  const loose = output.match(/\b(\d+)(?:\.\d+)*\b/);
  return loose ? Number.parseInt(loose[1]!, 10) : null;
}

/**
 * Parse the embedded server major from the raw contents of `<dataDir>/PG_VERSION`.
 * That file holds just the major (e.g. `18`), or `9.6` on the pre-10 scheme.
 */
export function parsePgVersionFileContent(content: string): number | null {
  if (!content) return null;
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const match = firstLine.match(/^(\d+)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

export type PgMajorComparison =
  | { status: "ok"; clientMajor: number; serverMajor: number }
  | {
      status: "mismatch";
      clientMajor: number;
      serverMajor: number;
      /** True when the client is OLDER than the server — the silent-kill case. */
      clientBehind: boolean;
      message: string;
    }
  | {
      status: "unparseable";
      clientMajor: number | null;
      serverMajor: number | null;
      message: string;
    };

/**
 * Pure decision: does the resolved `pg_dump` client major match the embedded
 * server major? Input is the raw version strings (client = `pg_dump --version`
 * output, server = `PG_VERSION` contents) so parsing stays inside the pure unit.
 */
export function comparePgMajor(
  clientVersion: string,
  serverVersion: string,
): PgMajorComparison {
  const clientMajor = parsePgDumpVersionOutput(clientVersion);
  const serverMajor = parsePgVersionFileContent(serverVersion);

  if (clientMajor === null || serverMajor === null) {
    return {
      status: "unparseable",
      clientMajor,
      serverMajor,
      message:
        `Unable to determine the PostgreSQL major to compare (client=` +
        `${clientMajor ?? "unknown"}, server=${serverMajor ?? "unknown"}).`,
    };
  }

  if (clientMajor === serverMajor) {
    return { status: "ok", clientMajor, serverMajor };
  }

  const clientBehind = clientMajor < serverMajor;
  const message = clientBehind
    ? `pg_dump client major ${clientMajor} is OLDER than the embedded PostgreSQL server major ${serverMajor}; ` +
      `pg_dump will refuse to dump this server (server version mismatch) and the automatic backup is broken.`
    : `pg_dump client major ${clientMajor} does not match the embedded PostgreSQL server major ${serverMajor}; ` +
      `the postgresql-client pin has drifted from the embedded server.`;
  return { status: "mismatch", clientMajor, serverMajor, clientBehind, message };
}

export type PgClientVersionPreflightResult =
  | { outcome: "ok"; clientMajor: number; serverMajor: number }
  | { outcome: "mismatch"; clientMajor: number; serverMajor: number; message: string }
  | { outcome: "client_missing"; pgDumpPath: string; message: string }
  | { outcome: "unparseable"; message: string }
  | { outcome: "skipped"; message: string };

/** Reads the two version sources. Injectable so tests need no PG and no spawn. */
export type PgClientVersionPreflightIo = {
  /** Raw contents of `<dataDir>/PG_VERSION`, or null when the file is absent. */
  readServerVersion(dataDir: string): Promise<string | null>;
  /**
   * Raw `pg_dump --version` output. Throws with `code === "ENOENT"` when the
   * binary cannot be resolved on the PATH.
   */
  readClientVersion(pgDumpPath: string): Promise<string>;
};

function hasErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/** Default IO: real `<dataDir>/PG_VERSION` read + real `pg_dump --version` spawn. */
export const defaultPgClientVersionPreflightIo: PgClientVersionPreflightIo = {
  async readServerVersion(dataDir) {
    const file = join(dataDir, "PG_VERSION");
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  },
  async readClientVersion(pgDumpPath) {
    return await new Promise<string>((resolve, reject) => {
      execFile(pgDumpPath, ["--version"], { timeout: 10_000 }, (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((stdout || stderr || "").toString());
      });
    });
  },
};

/**
 * Resolve both version sources and compare their majors. Pure orchestration of
 * the injectable IO — no board push here (that is the reporter's job).
 */
export async function inspectPgClientVersion(opts: {
  dataDir: string;
  pgDumpPath: string;
  io?: PgClientVersionPreflightIo;
}): Promise<PgClientVersionPreflightResult> {
  const io = opts.io ?? defaultPgClientVersionPreflightIo;

  const serverVersion = await io.readServerVersion(opts.dataDir);
  if (serverVersion === null) {
    return {
      outcome: "skipped",
      message:
        `No PG_VERSION file under ${opts.dataDir}; the embedded server major is unknown, ` +
        `skipping the pg_dump-client preflight.`,
    };
  }

  let clientVersion: string;
  try {
    clientVersion = await io.readClientVersion(opts.pgDumpPath);
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return {
        outcome: "client_missing",
        pgDumpPath: opts.pgDumpPath,
        message:
          `pg_dump was not found (resolved path: ${opts.pgDumpPath}). The automatic control-plane ` +
          `backup cannot run without a postgresql-client whose major matches the embedded server.`,
      };
    }
    return {
      outcome: "unparseable",
      message: `Failed to read pg_dump --version (${opts.pgDumpPath}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const comparison = comparePgMajor(clientVersion, serverVersion);
  switch (comparison.status) {
    case "ok":
      return {
        outcome: "ok",
        clientMajor: comparison.clientMajor,
        serverMajor: comparison.serverMajor,
      };
    case "mismatch":
      return {
        outcome: "mismatch",
        clientMajor: comparison.clientMajor,
        serverMajor: comparison.serverMajor,
        message: comparison.message,
      };
    case "unparseable":
      return { outcome: "unparseable", message: comparison.message };
  }
}

/** Pure payload builder: preflight result → board issue title + description. */
export function buildPgClientVersionAlertContent(
  result: Extract<
    PgClientVersionPreflightResult,
    { outcome: "mismatch" | "client_missing" | "unparseable" }
  >,
  at: Date,
  pgDumpPath: string,
): { title: string; description: string } {
  const title = "Control-plane pg_dump client does not match embedded PostgreSQL";
  const lines: string[] = [
    "The control-plane backup preflight found a `pg_dump` client that cannot back up the " +
      "embedded PostgreSQL server. **The automatic backup is at risk** until the " +
      "`postgresql-client` major is aligned with the embedded server major.",
    "",
    `First observed: ${at.toISOString()}`,
    `Resolved pg_dump path: \`${pgDumpPath}\``,
    "",
  ];
  if (result.outcome === "mismatch") {
    lines.push(
      `- pg_dump client major: **${result.clientMajor}**`,
      `- embedded server major: **${result.serverMajor}**`,
      "",
      result.message,
    );
  } else {
    lines.push(result.message);
  }
  lines.push(
    "",
    "**Recovery (agent-doable, no root):** unpack the noble `postgresql-client-18` `.deb` with " +
      "`dpkg -x` into a user-writable prefix and invoke it as " +
      "`env -u LD_LIBRARY_PATH <prefix>/usr/lib/postgresql/18/bin/pg_dump ...`, pointing " +
      "`PAPERCLIP_PG_DUMP_PATH` at that binary, until `postgresql-client-18` is installed via apt.",
    "",
    "This issue is auto-managed (deduplicated by origin fingerprint " +
      `\`${PGCLIENT_VERSION_ALERT_FINGERPRINT}\`). It is resolved automatically once the ` +
      "client major matches the embedded server major.",
  );
  return { title, description: lines.join("\n") };
}

export type PgClientVersionPreflightReporterDeps = {
  dataDir: string;
  pgDumpPath: string;
  /** Board port + target company. Null disables the board channel (log only). */
  board: DatabaseBackupAlertBoard | null;
  companyId: string | null;
  fingerprint?: string;
  io?: PgClientVersionPreflightIo;
  now?: () => Date;
  logger?: DatabaseBackupAlertLogger;
};

/**
 * Reporter that runs the preflight and pushes the result through the SIN-70819
 * board adapter: raise a LOUD alert on divergence / missing client, resolve the
 * open alert when the majors line up again. The board push is guarded so it can
 * never mask or crash the boot path.
 */
export function createPgClientVersionPreflightReporter(
  deps: PgClientVersionPreflightReporterDeps,
) {
  const fingerprint = deps.fingerprint ?? PGCLIENT_VERSION_ALERT_FINGERPRINT;
  const now = deps.now ?? (() => new Date());

  return {
    async run(): Promise<PgClientVersionPreflightResult> {
      const result = await inspectPgClientVersion({
        dataDir: deps.dataDir,
        pgDumpPath: deps.pgDumpPath,
        io: deps.io,
      });

      if (result.outcome === "skipped") {
        deps.logger?.info({ pgDumpPath: deps.pgDumpPath }, result.message);
        return result;
      }

      if (result.outcome === "ok") {
        deps.logger?.info(
          { clientMajor: result.clientMajor, serverMajor: result.serverMajor, pgDumpPath: deps.pgDumpPath },
          "pg_dump client major matches embedded PostgreSQL; backup preflight ok",
        );
        // Symmetric resolve: if a prior mismatch alert is open and the client
        // has since been aligned, close it automatically.
        if (deps.board && deps.companyId) {
          try {
            const resolved = await resolveDatabaseBackupAlert(deps.board, {
              companyId: deps.companyId,
              fingerprint,
              comment:
                `pg_dump client major ${result.clientMajor} now matches the embedded PostgreSQL ` +
                `server major ${result.serverMajor} (checked ${now().toISOString()}); resolving this alert.`,
            });
            if (resolved.action === "resolved") {
              deps.logger?.info(
                { issueId: resolved.issueId },
                "resolved control-plane pg_dump client-major mismatch board alert",
              );
            }
          } catch (err) {
            deps.logger?.error({ err }, "failed to resolve pg_dump client-major board alert");
          }
        }
        return result;
      }

      // mismatch | client_missing | unparseable → LOUD signal.
      deps.logger?.warn(
        {
          outcome: result.outcome,
          pgDumpPath: deps.pgDumpPath,
          ...(result.outcome === "mismatch"
            ? { clientMajor: result.clientMajor, serverMajor: result.serverMajor }
            : {}),
        },
        `control-plane pg_dump-client preflight failed: ${result.message}`,
      );

      if (!deps.board || !deps.companyId) return result;
      try {
        const { title, description } = buildPgClientVersionAlertContent(
          result,
          now(),
          deps.pgDumpPath,
        );
        const raised = await raiseDatabaseBackupAlert(deps.board, {
          companyId: deps.companyId,
          fingerprint,
          title,
          description,
        });
        deps.logger?.warn(
          { action: raised.action, issueId: raised.issueId, outcome: result.outcome },
          "raised control-plane pg_dump client-major mismatch board alert",
        );
      } catch (err) {
        deps.logger?.error({ err }, "failed to raise pg_dump client-major board alert");
      }
      return result;
    },
  };
}

export type PgClientVersionPreflightReporter = ReturnType<
  typeof createPgClientVersionPreflightReporter
>;
