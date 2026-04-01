/**
 * Email bridge for IronWorks.
 *
 * Webhook-based: receives parsed inbound emails from Mailgun or SendGrid,
 * creates Issues in the corresponding company.
 *
 * Address pattern: ceo@{company-slug}.ironworksapp.ai
 * Thread tracking: In-Reply-To / References headers map to existing Issues.
 *
 * No persistent connections needed — purely webhook-driven.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { companies, issues } from "@ironworksai/db";
import { issueService } from "../services/issues.js";
import { agentService } from "../services/agents.js";

// ── Types ──

interface ParsedInboundEmail {
  /** Sender email address */
  from: string;
  /** Recipient address (e.g. ceo@acme.ironworksapp.ai) */
  to: string;
  /** Email subject line */
  subject: string;
  /** Plain text body */
  body: string;
  /** HTML body (optional) */
  htmlBody?: string;
  /** Message-ID header for thread tracking */
  messageId?: string;
  /** In-Reply-To header for thread tracking */
  inReplyTo?: string;
  /** References header for thread tracking */
  references?: string;
}

// ── Helpers ──

/**
 * Extract company slug from recipient address.
 * Pattern: ceo@{slug}.ironworksapp.ai or anything@{slug}.ironworksapp.ai
 */
function extractCompanySlug(recipient: string): string | null {
  const match = recipient.match(/@([^.]+)\.ironworksapp\.ai/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Find a company by name (used as slug).
 * Since companies don't have a slug column, we match by lowercased name
 * with spaces/special chars removed.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function findCompanyBySlug(
  db: Db,
  slug: string,
): Promise<{ id: string; name: string } | null> {
  const allCompanies = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.status, "active"));

  for (const company of allCompanies) {
    if (slugify(company.name) === slug) {
      return company;
    }
  }
  return null;
}

/**
 * Find a CEO agent for a company.
 */
async function findCeoAgent(db: Db, companyId: string): Promise<string | null> {
  const svc = agentService(db);
  try {
    const agents = await svc.list(companyId);
    const ceo = (agents as Array<{ id: string; role?: string; title?: string }>).find(
      (a) =>
        a.role?.toLowerCase() === "ceo" ||
        a.title?.toLowerCase()?.includes("ceo"),
    );
    return ceo?.id ?? (agents as Array<{ id: string }>)[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Look for an existing Issue created from this email thread.
 * Uses the email Message-ID stored in issue originId.
 */
async function findExistingThread(
  db: Db,
  companyId: string,
  inReplyTo: string | undefined,
  references: string | undefined,
): Promise<string | null> {
  if (!inReplyTo && !references) return null;

  // Collect all message IDs that could identify the thread
  const messageIds: string[] = [];
  if (inReplyTo) messageIds.push(inReplyTo.trim());
  if (references) {
    messageIds.push(
      ...references
        .split(/\s+/)
        .map((r) => r.trim())
        .filter(Boolean),
    );
  }

  for (const mid of messageIds) {
    try {
      const found = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "email_bridge"),
            eq(issues.originId, mid),
          ),
        )
        .limit(1);
      if (found.length > 0) return found[0].id;
    } catch {
      // continue
    }
  }
  return null;
}

// ── Parse webhooks from different providers ──

/**
 * Parse Mailgun inbound webhook payload.
 */
function parseMailgunPayload(body: Record<string, unknown>): ParsedInboundEmail | null {
  // Mailgun posts form data with these fields
  const from = (body.from as string) ?? (body.sender as string) ?? "";
  const to = (body.recipient as string) ?? (body.To as string) ?? "";
  const subject = (body.subject as string) ?? (body.Subject as string) ?? "";
  const textBody = (body["body-plain"] as string) ?? (body["stripped-text"] as string) ?? "";
  const htmlBody = (body["body-html"] as string) ?? (body["stripped-html"] as string) ?? undefined;
  const messageId = (body["Message-Id"] as string) ?? (body["message-id"] as string) ?? undefined;
  const inReplyTo = (body["In-Reply-To"] as string) ?? (body["in-reply-to"] as string) ?? undefined;
  const references = (body["References"] as string) ?? (body["references"] as string) ?? undefined;

  if (!from || !to) return null;

  return { from, to, subject, body: textBody, htmlBody, messageId, inReplyTo, references };
}

/**
 * Parse SendGrid inbound parse webhook payload.
 */
function parseSendGridPayload(body: Record<string, unknown>): ParsedInboundEmail | null {
  const from = (body.from as string) ?? "";
  const to = (body.to as string) ?? "";
  const subject = (body.subject as string) ?? "";
  const textBody = (body.text as string) ?? "";
  const htmlBody = (body.html as string) ?? undefined;
  // SendGrid sends envelope as JSON string
  const headers = (body.headers as string) ?? "";

  let messageId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;

  // Try to extract headers
  const messageIdMatch = headers.match(/Message-Id:\s*(.+)/i);
  if (messageIdMatch) messageId = messageIdMatch[1].trim();
  const inReplyToMatch = headers.match(/In-Reply-To:\s*(.+)/i);
  if (inReplyToMatch) inReplyTo = inReplyToMatch[1].trim();
  const referencesMatch = headers.match(/References:\s*(.+)/i);
  if (referencesMatch) references = referencesMatch[1].trim();

  if (!from || !to) return null;

  return { from, to, subject, body: textBody, htmlBody, messageId, inReplyTo, references };
}

// ── Webhook handler ──

/**
 * Handle inbound email webhook. Supports both Mailgun and SendGrid formats.
 */
export async function handleInboundEmail(
  db: Db,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; issueId?: string; error?: string }> {
  // Try Mailgun first, then SendGrid
  const parsed = parseMailgunPayload(body) ?? parseSendGridPayload(body);
  if (!parsed) {
    return { ok: false, error: "Could not parse inbound email payload" };
  }

  // Extract company slug from recipient
  const slug = extractCompanySlug(parsed.to);
  if (!slug) {
    return { ok: false, error: `Could not determine company from recipient: ${parsed.to}` };
  }

  // Find company
  const company = await findCompanyBySlug(db, slug);
  if (!company) {
    return { ok: false, error: `No company found for slug: ${slug}` };
  }

  // Check for existing thread (reply to existing issue)
  const existingIssueId = await findExistingThread(
    db,
    company.id,
    parsed.inReplyTo,
    parsed.references,
  );

  const issueSvc = issueService(db);

  if (existingIssueId) {
    // Add comment to existing issue
    try {
      await issueSvc.addComment(
        existingIssueId,
        `[Email from ${parsed.from}]:\n\n${parsed.body}`,
        { userId: "email-bridge" },
      );
      return { ok: true, issueId: existingIssueId };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // Create new issue
  const ceoAgentId = await findCeoAgent(db, company.id);

  try {
    const issue = await issueSvc.create(company.id, {
      title: parsed.subject || `Email from ${parsed.from}`,
      description: `From: ${parsed.from}\nSubject: ${parsed.subject}\n\n${parsed.body}`,
      assigneeAgentId: ceoAgentId ?? undefined,
      status: "todo",
      originKind: "email_bridge",
      originId: parsed.messageId ?? undefined,
    });

    return { ok: true, issueId: (issue as { id: string }).id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Generate the inbound email address for a company.
 */
export function getCompanyEmailAddress(companyName: string): string {
  return `ceo@${slugify(companyName)}.ironworksapp.ai`;
}
