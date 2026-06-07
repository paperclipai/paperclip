import { createHash, randomBytes } from "node:crypto";
import { createDb, invites } from "@paperclipai/db";
import { and, eq, gt, isNull } from "drizzle-orm";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error("FAIL: DATABASE_URL not set"); process.exit(1); }

try {
  const db = createDb(dbUrl);

  function hashToken(t: string) { return createHash("sha256").update(t).digest("hex"); }

  const token = "pcp_bootstrap_" + randomBytes(24).toString("hex");
  const now = new Date();
  const expires = new Date(Date.now() + 72 * 60 * 60 * 1000);

  await db.update(invites)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(invites.inviteType, "bootstrap_ceo"),
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .catch(() => {});

  await db.insert(invites).values({
    inviteType: "bootstrap_ceo",
    tokenHash: hashToken(token),
    allowedJoinTypes: "human",
    expiresAt: expires,
    invitedByUserId: "system",
  });

  console.log(token);

  const client = (db as typeof db & { $client?: { end?: () => Promise<void> } }).$client;
  if (client?.end) await client.end();
  process.exit(0);
} catch (err) {
  console.error("FAIL: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
