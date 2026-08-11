import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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
      connectionString?: string;
    };
  };
  const dbUrl =
    config.database?.mode === "postgres"
      ? config.database.connectionString
      : `postgres://paperclip:paperclip@127.0.0.1:${config.database?.embeddedPostgresPort ?? 54329}/paperclip`;
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
