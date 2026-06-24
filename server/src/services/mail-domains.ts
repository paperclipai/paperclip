import { and, desc, eq } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { mailDomains } from "@paperclipai/db";
import type { MailDomain } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { secretService } from "./secrets.js";
import { cloudflareService } from "./cloudflare.js";

const DKIM_SELECTOR = "atl1";

/** Mail host the attached domains route to (set once the mail engine is deployed). */
function mailHostConfig() {
  return {
    hostname: process.env.MAIL_HOSTNAME?.trim() || "",
    publicIp: process.env.MAIL_PUBLIC_IP?.trim() || "",
  };
}

export type MailDomainActor = { actorType: "user" | "agent"; actorId: string };

type MailDomainRow = typeof mailDomains.$inferSelect;

function toMailDomain(row: MailDomainRow): MailDomain {
  return {
    id: row.id,
    companyId: row.companyId,
    domain: row.domain,
    provider: row.provider,
    cfZoneId: row.cfZoneId,
    status: row.status as MailDomain["status"],
    dkimSelector: row.dkimSelector,
    dkimPublicKey: row.dkimPublicKey,
    mxConfigured: row.mxConfigured,
    spfConfigured: row.spfConfigured,
    dmarcConfigured: row.dmarcConfigured,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Generate a DKIM RSA keypair: pkcs8 PEM private key + base64 DER public key. */
function generateDkimKeypair(): { privatePem: string; publicB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { privatePem, publicB64 };
}

export function mailDomainService(db: Db) {
  const secrets = secretService(db);
  const cloudflare = cloudflareService(db);

  async function getRow(companyId: string, id: string): Promise<MailDomainRow | null> {
    return db
      .select()
      .from(mailDomains)
      .where(and(eq(mailDomains.id, id), eq(mailDomains.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getRowByDomain(companyId: string, domain: string): Promise<MailDomainRow | null> {
    return db
      .select()
      .from(mailDomains)
      .where(and(eq(mailDomains.companyId, companyId), eq(mailDomains.domain, domain)))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Publish the mail DNS records for a domain on its Cloudflare zone. DKIM, SPF
   * and DMARC are always safe to publish; MX is only published once a mail host
   * is configured (otherwise inbound mail would route to nothing).
   */
  async function publishRecords(
    companyId: string,
    zoneId: string,
    domain: string,
    dkimPublicB64: string,
  ): Promise<{ mx: boolean; spf: boolean; dmarc: boolean }> {
    const host = mailHostConfig();

    // DKIM is always publishable (it is just a public key).
    await cloudflare.upsertDnsRecord(companyId, zoneId, {
      type: "TXT",
      name: `${DKIM_SELECTOR}._domainkey.${domain}`,
      content: `v=DKIM1; k=rsa; p=${dkimPublicB64}`,
    });

    let spf = false;
    if (host.publicIp || host.hostname) {
      const mechanism = host.publicIp ? `ip4:${host.publicIp}` : `a:${host.hostname}`;
      await cloudflare.upsertDnsRecord(companyId, zoneId, {
        type: "TXT",
        name: domain,
        content: `v=spf1 ${mechanism} ~all`,
      });
      spf = true;
    }

    await cloudflare.upsertDnsRecord(companyId, zoneId, {
      type: "TXT",
      name: `_dmarc.${domain}`,
      content: `v=DMARC1; p=none; rua=mailto:postmaster@${domain}`,
    });

    let mx = false;
    if (host.hostname) {
      await cloudflare.upsertDnsRecord(companyId, zoneId, {
        type: "MX",
        name: domain,
        content: host.hostname,
        priority: 10,
      });
      mx = true;
    }

    return { mx, spf, dmarc: true };
  }

  return {
    list: async (companyId: string): Promise<MailDomain[]> => {
      const rows = await db
        .select()
        .from(mailDomains)
        .where(eq(mailDomains.companyId, companyId))
        .orderBy(desc(mailDomains.createdAt));
      return rows.map(toMailDomain);
    },

    get: async (companyId: string, id: string): Promise<MailDomain> => {
      const row = await getRow(companyId, id);
      if (!row) throw notFound("Mail domain not found");
      return toMailDomain(row);
    },

    /** Cloudflare zones the human can attach (delegates to the connection). */
    listAttachableZones: (companyId: string) => cloudflare.listZones(companyId),

    /**
     * Attach an existing Cloudflare zone for email: generate a DKIM keypair,
     * persist the domain, and publish the mail DNS records. Idempotent on
     * (companyId, domain): re-attaching reuses the existing DKIM key and
     * re-publishes the records.
     */
    attach: async (companyId: string, domain: string, actor: MailDomainActor): Promise<MailDomain> => {
      const normalizedDomain = domain.trim().toLowerCase();
      const actorRef = {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.actorType === "agent" ? actor.actorId : null,
      };

      const zoneId = await cloudflare.getZoneId(companyId, normalizedDomain);
      const existing = await getRowByDomain(companyId, normalizedDomain);

      // Reuse or create the DKIM key (stored as a company secret).
      let dkimPublicKey: string;
      let dkimPrivateKeySecretId: string;
      const secretName = `mail-dkim:${normalizedDomain}`;
      if (existing?.dkimPrivateKeySecretId && existing.dkimPublicKey) {
        dkimPublicKey = existing.dkimPublicKey;
        dkimPrivateKeySecretId = existing.dkimPrivateKeySecretId;
      } else {
        const { privatePem, publicB64 } = generateDkimKeypair();
        dkimPublicKey = publicB64;
        const existingSecret = await secrets.getByName(companyId, secretName);
        if (existingSecret) {
          await secrets.rotate(existingSecret.id, { value: privatePem }, actorRef);
          dkimPrivateKeySecretId = existingSecret.id;
        } else {
          const created = await secrets.create(
            companyId,
            { name: secretName, provider: "local_encrypted", value: privatePem },
            actorRef,
          );
          dkimPrivateKeySecretId = created.id;
        }
      }

      const now = new Date();
      let row: MailDomainRow;
      if (existing) {
        row = await db
          .update(mailDomains)
          .set({ cfZoneId: zoneId, dkimSelector: DKIM_SELECTOR, dkimPrivateKeySecretId, dkimPublicKey, updatedAt: now })
          .where(eq(mailDomains.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      } else {
        row = await db
          .insert(mailDomains)
          .values({
            companyId,
            domain: normalizedDomain,
            provider: "cloudflare",
            cfZoneId: zoneId,
            status: "pending",
            dkimSelector: DKIM_SELECTOR,
            dkimPrivateKeySecretId,
            dkimPublicKey,
            createdByAgentId: actorRef.agentId,
            createdByUserId: actorRef.userId,
          })
          .returning()
          .then((rows) => rows[0]);
      }

      // Publish DNS; on failure, record the error and surface a failed status.
      try {
        const flags = await publishRecords(companyId, zoneId, normalizedDomain, dkimPublicKey);
        const status = flags.mx && flags.spf ? "active" : "dns_configured";
        row = await db
          .update(mailDomains)
          .set({
            mxConfigured: flags.mx,
            spfConfigured: flags.spf,
            dmarcConfigured: flags.dmarc,
            status,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(mailDomains.id, row.id))
          .returning()
          .then((rows) => rows[0]);
      } catch (err) {
        logger.warn({ err, companyId, domain: normalizedDomain }, "failed to publish mail DNS records");
        const message = err instanceof Error ? err.message : "DNS publish failed";
        row = await db
          .update(mailDomains)
          .set({ status: "failed", lastError: message, updatedAt: new Date() })
          .where(eq(mailDomains.id, row.id))
          .returning()
          .then((rows) => rows[0]);
      }
      return toMailDomain(row);
    },

    /** Re-publish + re-evaluate a domain's DNS records (e.g. after the mail host is set). */
    verify: async (companyId: string, id: string): Promise<MailDomain> => {
      const row = await getRow(companyId, id);
      if (!row) throw notFound("Mail domain not found");
      if (!row.cfZoneId || !row.dkimPublicKey) throw unprocessable("Domain is missing zone or DKIM key");
      const flags = await publishRecords(companyId, row.cfZoneId, row.domain, row.dkimPublicKey);
      const status = flags.mx && flags.spf ? "active" : "dns_configured";
      const updated = await db
        .update(mailDomains)
        .set({
          mxConfigured: flags.mx,
          spfConfigured: flags.spf,
          dmarcConfigured: flags.dmarc,
          status,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(mailDomains.id, id))
        .returning()
        .then((rows) => rows[0]);
      return toMailDomain(updated);
    },

    remove: async (companyId: string, id: string): Promise<void> => {
      const deleted = await db
        .delete(mailDomains)
        .where(and(eq(mailDomains.id, id), eq(mailDomains.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!deleted) throw notFound("Mail domain not found");
    },
  };
}
