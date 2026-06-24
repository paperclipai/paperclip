import { pgTable, uuid, text, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * A domain attached to a company for embedded email (phase 0).
 *
 * The human picks one of their existing Cloudflare zones; the platform generates
 * a DKIM keypair and publishes the mail DNS records (MX -> the Atelier mail host,
 * SPF, DKIM, DMARC) on that zone via the Cloudflare API. AI-driven domain
 * registration is out of scope for V1: a row here always maps to a zone the
 * account already owns.
 *
 * The DKIM private key never lives here: it is stored in `company_secrets` and
 * referenced by `dkimPrivateKeySecretId` (secret_ref pattern). The public key is
 * published in DNS and kept here for inspection.
 */
export const mailDomains = pgTable(
  "mail_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    domain: text("domain").notNull(),
    provider: text("provider").notNull().default("cloudflare"),
    cfZoneId: text("cf_zone_id"),
    status: text("status").notNull().default("pending"),
    dkimSelector: text("dkim_selector").notNull(),
    dkimPrivateKeySecretId: uuid("dkim_private_key_secret_id"),
    dkimPublicKey: text("dkim_public_key"),
    mxConfigured: boolean("mx_configured").notNull().default(false),
    spfConfigured: boolean("spf_configured").notNull().default(false),
    dmarcConfigured: boolean("dmarc_configured").notNull().default(false),
    lastError: text("last_error"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDomainUq: uniqueIndex("mail_domains_company_domain_uq").on(table.companyId, table.domain),
    companyStatusIdx: index("mail_domains_company_status_idx").on(table.companyId, table.status),
  }),
);
