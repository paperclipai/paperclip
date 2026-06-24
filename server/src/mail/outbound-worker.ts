import { resolveMx } from "node:dns/promises";
import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mailAddresses, mailDomains, mailMessages } from "@paperclipai/db";
import { secretService } from "../services/secrets.js";
import { mailMessageService } from "../services/mail-messages.js";
import { logger } from "../middleware/logger.js";

const DKIM_SECRET_ENV = "MAIL_DKIM_PRIVATE_KEY";

export interface MailWorkerHandle {
  stop: () => void;
}

type OutboundRow = typeof mailMessages.$inferSelect;

/** Resolve the sender domain's DKIM signing material for an outbound message. */
async function resolveDkim(
  db: Db,
  companyId: string,
  addressId: string,
): Promise<{ domain: string; selector: string; privateKey: string } | null> {
  const row = await db
    .select({
      domain: mailDomains.domain,
      selector: mailDomains.dkimSelector,
      keySecretId: mailDomains.dkimPrivateKeySecretId,
    })
    .from(mailAddresses)
    .innerJoin(mailDomains, eq(mailAddresses.domainId, mailDomains.id))
    .where(eq(mailAddresses.id, addressId))
    .then((rows) => rows[0] ?? null);
  if (!row || !row.keySecretId) return null;
  const resolved = await secretService(db).resolveEnvBindings(companyId, {
    [DKIM_SECRET_ENV]: { type: "secret_ref", secretId: row.keySecretId, version: "latest" },
  });
  const privateKey = resolved.env[DKIM_SECRET_ENV];
  if (!privateKey) return null;
  return { domain: row.domain, selector: row.selector, privateKey };
}

/** Deliver one outbound message directly to each recipient's MX, DKIM-signed. */
async function deliver(db: Db, msg: OutboundRow): Promise<void> {
  const dkim = await resolveDkim(db, msg.companyId, msg.addressId);
  if (!dkim) throw new Error("no DKIM key for the sender domain");

  const recipients = [...(msg.toAddrs ?? []), ...(msg.ccAddrs ?? [])];
  const byDomain = new Map<string, string[]>();
  for (const r of recipients) {
    const domain = r.split("@")[1]?.toLowerCase();
    if (!domain) continue;
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), r]);
  }
  if (byDomain.size === 0) throw new Error("no valid recipients");

  for (const [domain, rcpts] of byDomain) {
    const mxs = await resolveMx(domain).catch(() => []);
    if (mxs.length === 0) throw new Error(`no MX for ${domain}`);
    const mx = mxs.sort((a, b) => a.priority - b.priority)[0].exchange;
    const transport = nodemailer.createTransport({
      host: mx,
      port: 25,
      secure: false,
      tls: { rejectUnauthorized: false },
      ...(process.env.MAIL_HOSTNAME ? { name: process.env.MAIL_HOSTNAME.trim() } : {}),
      dkim: { domainName: dkim.domain, keySelector: dkim.selector, privateKey: dkim.privateKey },
    });
    await transport.sendMail({
      from: msg.fromAddr,
      to: rcpts,
      subject: msg.subject ?? undefined,
      text: msg.textBody ?? undefined,
      html: msg.htmlBody ?? undefined,
      ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo, references: msg.inReplyTo } : {}),
    });
  }
}

async function tick(db: Db): Promise<void> {
  const messages = mailMessageService(db);
  const due = await messages.claimDueOutbound(new Date(), 10);
  for (const msg of due) {
    try {
      await deliver(db, msg);
      await messages.markSent(msg.id);
      logger.info({ id: msg.id, to: msg.toAddrs }, "outbound mail sent");
    } catch (err) {
      const message = err instanceof Error ? err.message : "send failed";
      await messages.markFailed(msg.id, message);
      logger.warn({ err, id: msg.id }, "outbound mail send failed");
    }
  }
}

/**
 * In-process outbound mail worker (embedded mail, phase 2). Polls the queue and
 * delivers messages directly to each recipient MX, DKIM-signed. Enabled with
 * MAIL_ENABLED=true (same flag as the inbound listener).
 */
export function startMailOutboundWorker(db: Db): MailWorkerHandle | null {
  if ((process.env.MAIL_ENABLED ?? "").trim().toLowerCase() !== "true") return null;
  const intervalMs = Number(process.env.MAIL_OUTBOUND_INTERVAL_MS ?? 15_000);
  const timer = setInterval(() => {
    void tick(db).catch((err) => logger.warn({ err }, "outbound mail tick failed"));
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info({ intervalMs }, "mail outbound worker started");
  return { stop: () => clearInterval(timer) };
}
