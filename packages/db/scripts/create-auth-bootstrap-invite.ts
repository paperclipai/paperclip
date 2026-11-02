import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDb } from "../src/client.js";
import { invites } from "../src/schema/index.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createInviteToken() {
  return `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
}

function readArg(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function main() {
  const configPath = readArg("--config");
  const baseUrl = readArg("--base-url");

  if (!configPath || !baseUrl) {
    throw new Error("Usage: tsx create-auth-bootstrap-invite.ts --config <path> --base-url <url>");
  }

  const config = JSON.parse(readFileSync(path.resolve(configPath), "utf8")) as {
    database?: {
      mode?: string;
      embeddedPostgresPort?: number;
      embeddedPostgresDataDir?: string;
      connectionString?: string;
    };
  };
  // The server can select another port when the configured one is occupied.
  // Bind bootstrap to this data directory's running process, never another instance.
  let embeddedPort: number | undefined;
  if (config.database?.mode !== "postgres") {
    const dataDir = config.database?.embeddedPostgresDataDir;
    if (!dataDir) throw new Error("Embedded bootstrap requires its configured data directory");
    const pidLines = readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split(/\r?\n/);
    if (realpathSync(pidLines[1] ?? "") !== realpathSync(dataDir)) throw new Error("Embedded bootstrap data directory does not match the running postmaster");
    const postmasterPid = Number(pidLines[0]);
    if (!Number.isInteger(postmasterPid) || postmasterPid <= 1) throw new Error("Invalid embedded postmaster PID");
    process.kill(postmasterPid, 0);
    embeddedPort = Number(pidLines[3]);
    if (!Number.isInteger(embeddedPort) || embeddedPort < 1 || embeddedPort > 65535) throw new Error("Invalid running embedded database port");
  }
  const dbUrl =
    config.database?.mode === "postgres"
      ? config.database.connectionString
      : `postgres://paperclip:paperclip@127.0.0.1:${embeddedPort}/paperclip`;
  if (!dbUrl) {
    throw new Error(`Could not resolve database connection from ${configPath}`);
  }

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: {
      end?: (options?: { timeout?: number }) => Promise<void>;
    };
  };

  try {
    const now = new Date();
    await db
      .update(invites)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(invites.inviteType, "bootstrap_ceo"),
          isNull(invites.revokedAt),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now)
        )
      );

    const token = createInviteToken();
    await db.insert(invites).values({
      inviteType: "bootstrap_ceo",
      tokenHash: hashToken(token),
      allowedJoinTypes: "human",
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      invitedByUserId: "system",
    });

    process.stdout.write(`${baseUrl.replace(/\/+$/, "")}/invite/${token}\n`);
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
