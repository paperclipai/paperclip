import { SMTPServer, type SMTPServerSession } from "smtp-server";
import { simpleParser } from "mailparser";
import type { Db } from "@paperclipai/db";
import { mailAddressService, mailMessageService } from "../services/index.js";
import { logger } from "../middleware/logger.js";

export interface MailListenerHandle {
  port: number;
  close: () => Promise<void>;
}

type ResolvedRecipient = { id: string; companyId: string; agentId: string | null; address: string };

// Per-session resolved recipients (keyed by the smtp-server session object).
const sessionRecipients = new WeakMap<SMTPServerSession, ResolvedRecipient[]>();

/**
 * In-process inbound SMTP listener (embedded mail, phase 1). Accepts mail only
 * for known addresses (no open relay), parses the MIME, and stores one message
 * per matched recipient. Enabled by MAIL_ENABLED=true; binds MAIL_SMTP_PORT
 * (default 2525, mapped to host port 25 in deployment).
 */
export function startMailListener(db: Db): MailListenerHandle | null {
  if ((process.env.MAIL_ENABLED ?? "").trim().toLowerCase() !== "true") return null;

  const port = Number(process.env.MAIL_SMTP_PORT ?? 2525);
  const hostname = process.env.MAIL_HOSTNAME?.trim() || "atelier-mail";
  const addresses = mailAddressService(db);
  const messages = mailMessageService(db);

  const server = new SMTPServer({
    name: hostname,
    banner: "Atelier mail",
    authOptional: true,
    disabledCommands: ["AUTH"],
    size: 25 * 1024 * 1024,

    onRcptTo(address, session, callback) {
      addresses
        .resolveRecipient(address.address)
        .then((row) => {
          if (!row) {
            callback(new Error("550 5.1.1 Unknown recipient"));
            return;
          }
          const list = sessionRecipients.get(session) ?? [];
          list.push({ id: row.id, companyId: row.companyId, agentId: row.agentId, address: row.address });
          sessionRecipients.set(session, list);
          callback();
        })
        .catch((err) => callback(err instanceof Error ? err : new Error("451 temporary failure")));
    },

    onData(stream, session, callback) {
      simpleParser(stream)
        .then(async (parsed) => {
          const recipients = sessionRecipients.get(session) ?? [];
          sessionRecipients.delete(session);
          const envelopeFrom =
            typeof session.envelope.mailFrom === "object" && session.envelope.mailFrom
              ? session.envelope.mailFrom.address
              : undefined;
          const fromAddr = parsed.from?.value?.[0]?.address || parsed.from?.text || envelopeFrom || "unknown";
          const toAddrs = session.envelope.rcptTo.map((r) => r.address);
          const htmlBody = typeof parsed.html === "string" ? parsed.html : null;

          for (const rcpt of recipients) {
            await messages
              .recordInbound(rcpt.companyId, {
                addressId: rcpt.id,
                agentId: rcpt.agentId,
                fromAddr,
                toAddrs,
                subject: parsed.subject ?? null,
                textBody: parsed.text ?? null,
                htmlBody,
                messageId: parsed.messageId ?? null,
                inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : null,
              })
              .catch((err) => logger.warn({ err, address: rcpt.address }, "failed to store inbound mail"));
          }
          callback();
        })
        .catch((err) => {
          logger.warn({ err }, "failed to parse inbound mail");
          callback(err instanceof Error ? err : new Error("451 temporary failure"));
        });
    },
  });

  server.on("error", (err) => logger.warn({ err }, "SMTP server error"));
  server.listen(port, () => logger.info({ port, hostname }, "mail SMTP listener started"));

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
