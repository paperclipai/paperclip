/**
 * Agency self-serve registration and CAD webhook setup wizard.
 *
 * Public routes (no auth):
 *   POST /api/agency/register     — create company + webhook config + trial, return creds
 *   GET  /api/agency/setup-wizard — step-by-step instructions per CAD vendor
 *
 * Authenticated board routes:
 *   GET  /agency/trial/:trialId         — trial detail (for upgrade page)
 *   POST /agency/trial/:trialId/upgrade — convert trial to paid
 */

import { randomBytes } from "node:crypto";
import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, agencyWebhookConfigs, agencyTrials, agencyTrialEmails } from "@paperclipai/db";
import { assertBoard } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import type { AgencyEmailClient } from "../services/agency-email.js";

// ---------------------------------------------------------------------------
// CAD vendor setup wizard content
// ---------------------------------------------------------------------------

type WizardStep = {
  step: number;
  title: string;
  description: string;
  fields?: Array<{ label: string; value: string; copyable?: boolean }>;
  notes?: string;
};

type VendorWizard = {
  vendor: string;
  vendorName: string;
  steps: WizardStep[];
};

function buildTritechWizard(webhookUrl: string, secret: string, agencyCode: string): VendorWizard {
  return {
    vendor: "tritech",
    vendorName: "TriTech Inform CAD",
    steps: [
      {
        step: 1,
        title: "Open External Notifications",
        description:
          "In TriTech Inform CAD, go to System Administration → External Notifications → Add New Notification.",
      },
      {
        step: 2,
        title: "Configure endpoint",
        description: "Set the notification URL and authentication headers:",
        fields: [
          { label: "Notification URL", value: webhookUrl, copyable: true },
          { label: "Header: x-cad-agency-code", value: agencyCode, copyable: true },
          {
            label: "Header: x-cad-signature",
            value: "(auto-computed by TriTech using your webhook secret)",
            copyable: false,
          },
        ],
      },
      {
        step: 3,
        title: "Configure HMAC signing",
        description:
          "In the External Notification settings, enable Request Signing and paste your webhook secret:",
        fields: [{ label: "Webhook secret", value: secret, copyable: true }],
        notes: "TriTech prefixes the signature header with 'sha256='. Solaris expects this format.",
      },
      {
        step: 4,
        title: "Send a test notification",
        description:
          "Click 'Send Test Notification' in TriTech. You should receive a 200 or 201 response. Check your Solaris alert feed — a test incident should appear within seconds.",
      },
    ],
  };
}

function buildMotorolaWizard(webhookUrl: string, secret: string, agencyCode: string): VendorWizard {
  return {
    vendor: "motorola",
    vendorName: "Motorola PremierOne CAD",
    steps: [
      {
        step: 1,
        title: "Open Integration Manager",
        description:
          "In Motorola PremierOne, navigate to System → Integration Manager → Add Integration.",
        notes: "You need the System Administrator role to access Integration Manager.",
      },
      {
        step: 2,
        title: "Create HTTP Push integration",
        description: "Select 'HTTP Push' as the integration type and configure the endpoint:",
        fields: [
          { label: "Endpoint URL", value: webhookUrl, copyable: true },
          { label: "Header: x-cad-agency-code", value: agencyCode, copyable: true },
          { label: "Content-Type", value: "application/xml", copyable: false },
        ],
      },
      {
        step: 3,
        title: "Configure HMAC authentication",
        description: "In the Authentication section, select 'HMAC-SHA256' and enter your secret:",
        fields: [{ label: "Shared secret", value: secret, copyable: true }],
        notes:
          "PremierOne sends the signature as 'sha256=<hex>' in the x-cad-signature header. Solaris expects this format.",
      },
      {
        step: 4,
        title: "Map incident fields",
        description:
          "Ensure the integration maps the following XML fields: IncidentNumber, NatureOfCall, IncidentCategory, Latitude, Longitude, CallReceivedDateTime, AgencyCode.",
      },
      {
        step: 5,
        title: "Send a test push",
        description:
          "Use the 'Send Test' button in Integration Manager. Your Solaris alert feed should show a new incident within seconds.",
      },
    ],
  };
}

function buildGenericWizard(webhookUrl: string, agencyCode: string): VendorWizard {
  return {
    vendor: "generic",
    vendorName: "Generic CAD (JSON)",
    steps: [
      {
        step: 1,
        title: "Configure your CAD system",
        description: "Configure your CAD system to POST JSON incident data to the webhook URL:",
        fields: [
          { label: "Webhook URL", value: webhookUrl, copyable: true },
          { label: "Header: x-cad-agency-code", value: agencyCode, copyable: true },
          { label: "Content-Type", value: "application/json", copyable: false },
        ],
      },
      {
        step: 2,
        title: "JSON payload schema",
        description: "Include these fields in the request body:",
        fields: [
          { label: "incident_id", value: "string (required, unique per incident)" },
          { label: "incident_name", value: "string — call type or nature" },
          { label: "incident_type", value: "string — category" },
          { label: "lat / lon", value: "number — decimal degrees" },
          { label: "reported_at", value: "ISO 8601 timestamp" },
        ],
      },
      {
        step: 3,
        title: "Optional HMAC signing",
        description:
          "For security, sign the request body with HMAC-SHA256 using your webhook secret and include the signature in the x-cad-signature header (prefixed with 'sha256=').",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a short uppercase issue prefix from an agency code (max 6 chars). */
function derivePrefix(agencyCode: string): string {
  return agencyCode.replace(/[^A-Z0-9]/g, "").slice(0, 6) || "SOL";
}

// ---------------------------------------------------------------------------
// Public registration routes
// ---------------------------------------------------------------------------

export function agencyRegistrationRoutes(db: Db, emailClient: AgencyEmailClient) {
  const router = Router();

  /**
   * POST /api/agency/register
   *
   * Body: { agencyName, agencyCode, contactEmail, contactName?, vendor? }
   * Returns: { trialId, webhookUrl, webhookSecret, agencyCode, trialEndsAt, setupWizard }
   */
  router.post("/api/agency/register", async (req, res) => {
    const body = req.body as Record<string, unknown>;

    const agencyName = typeof body["agencyName"] === "string" ? body["agencyName"].trim() : null;
    if (!agencyName) throw badRequest("agencyName is required");

    const rawCode =
      typeof body["agencyCode"] === "string" ? body["agencyCode"].trim().toUpperCase() : null;
    if (!rawCode) throw badRequest("agencyCode is required");
    if (!/^[A-Z0-9_-]{2,20}$/.test(rawCode)) {
      throw badRequest(
        "agencyCode must be 2–20 uppercase alphanumeric characters (hyphens and underscores allowed)",
      );
    }

    const contactEmail =
      typeof body["contactEmail"] === "string" ? body["contactEmail"].trim().toLowerCase() : null;
    if (!contactEmail || !contactEmail.includes("@")) throw badRequest("contactEmail is required");

    const contactName =
      typeof body["contactName"] === "string" ? body["contactName"].trim() : null;
    const vendor =
      typeof body["vendor"] === "string" ? body["vendor"].toLowerCase() : "generic";

    // Check for an existing active webhook config with this agency code (global uniqueness for trials)
    const existing = await db
      .select({ id: agencyWebhookConfigs.id })
      .from(agencyWebhookConfigs)
      .where(and(eq(agencyWebhookConfigs.agencyCode, rawCode), eq(agencyWebhookConfigs.isActive, true)))
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "Agency code is already registered. Choose a different code." });
      return;
    }

    // Determine a unique issue prefix for the trial company
    const basePrefix = derivePrefix(rawCode);
    let issuePrefix = basePrefix;
    let suffix = 2;
    while (true) {
      const prefixConflict = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.issuePrefix, issuePrefix))
        .limit(1);
      if (prefixConflict.length === 0) break;
      issuePrefix = `${basePrefix.slice(0, 4)}${suffix}`;
      suffix++;
    }

    // Create a trial company for this agency
    const [company] = await db
      .insert(companies)
      .values({ name: agencyName, issuePrefix, status: "trial" })
      .returning({ id: companies.id });

    // Generate a 32-byte HMAC secret (64 hex chars)
    const webhookSecret = randomBytes(32).toString("hex");

    // Insert webhook config
    const [config] = await db
      .insert(agencyWebhookConfigs)
      .values({ companyId: company.id, agencyName, agencyCode: rawCode, webhookSecret })
      .returning({ id: agencyWebhookConfigs.id });

    // Compute trial end date (30 days from now)
    const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Insert trial record
    const [trial] = await db
      .insert(agencyTrials)
      .values({ agencyWebhookConfigId: config.id, contactEmail, contactName, trialEndsAt })
      .returning({ id: agencyTrials.id, trialEndsAt: agencyTrials.trialEndsAt });

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const webhookUrl = `${baseUrl}/api/cad/webhook`;

    // Send welcome email (fire-and-forget)
    emailClient
      .sendWelcome({
        trialId: trial.id,
        contactEmail,
        contactName,
        agencyName,
        agencyCode: rawCode,
        webhookUrl,
        trialEndsAt: trial.trialEndsAt,
        incidentCount: 0,
        incidentCap: 1000,
      })
      .then(() =>
        db.insert(agencyTrialEmails).values({ trialId: trial.id, emailType: "welcome" }).catch(() => {}),
      )
      .catch((err: Error) =>
        console.warn("[agency-registration] welcome email failed:", err.message),
      );

    // Build vendor-specific setup wizard
    let wizard: VendorWizard;
    if (vendor === "tritech") {
      wizard = buildTritechWizard(webhookUrl, webhookSecret, rawCode);
    } else if (vendor === "motorola") {
      wizard = buildMotorolaWizard(webhookUrl, webhookSecret, rawCode);
    } else {
      wizard = buildGenericWizard(webhookUrl, rawCode);
    }

    res.status(201).json({
      trialId: trial.id,
      companyId: company.id,
      webhookUrl,
      webhookSecret,
      agencyCode: rawCode,
      trialEndsAt: trial.trialEndsAt,
      incidentCap: 1000,
      setupWizard: wizard,
    });
  });

  /**
   * GET /api/agency/setup-wizard?vendor=tritech|motorola|generic&agencyCode=&webhookUrl=
   *
   * Returns step-by-step CAD configuration instructions for a given vendor.
   * No auth required — used by the pre-registration onboarding UI.
   */
  router.get("/api/agency/setup-wizard", (req, res) => {
    const vendor =
      typeof req.query["vendor"] === "string" ? req.query["vendor"].toLowerCase() : "generic";
    const agencyCode =
      typeof req.query["agencyCode"] === "string"
        ? req.query["agencyCode"].toUpperCase()
        : "AGENCY";
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const webhookUrl =
      typeof req.query["webhookUrl"] === "string"
        ? req.query["webhookUrl"]
        : `${baseUrl}/api/cad/webhook`;
    const demoSecret = "(webhook secret from registration)";

    let wizard: VendorWizard;
    if (vendor === "tritech") {
      wizard = buildTritechWizard(webhookUrl, demoSecret, agencyCode);
    } else if (vendor === "motorola") {
      wizard = buildMotorolaWizard(webhookUrl, demoSecret, agencyCode);
    } else {
      wizard = buildGenericWizard(webhookUrl, agencyCode);
    }

    res.json(wizard);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Authenticated trial management routes
// ---------------------------------------------------------------------------

export function agencyTrialRoutes(db: Db, emailClient: AgencyEmailClient) {
  const router = Router();

  /** GET /agency/trial/:trialId */
  router.get("/agency/trial/:trialId", async (req, res) => {
    assertBoard(req);
    const { trialId } = req.params;

    const [trial] = await db
      .select({
        id: agencyTrials.id,
        contactEmail: agencyTrials.contactEmail,
        contactName: agencyTrials.contactName,
        trialStatus: agencyTrials.trialStatus,
        incidentCount: agencyTrials.incidentCount,
        incidentCap: agencyTrials.incidentCap,
        trialStartedAt: agencyTrials.trialStartedAt,
        trialEndsAt: agencyTrials.trialEndsAt,
        upgradedAt: agencyTrials.upgradedAt,
        agencyWebhookConfigId: agencyTrials.agencyWebhookConfigId,
      })
      .from(agencyTrials)
      .where(eq(agencyTrials.id, trialId))
      .limit(1);

    if (!trial) throw notFound("Trial not found");

    const [config] = await db
      .select({
        agencyName: agencyWebhookConfigs.agencyName,
        agencyCode: agencyWebhookConfigs.agencyCode,
      })
      .from(agencyWebhookConfigs)
      .where(eq(agencyWebhookConfigs.id, trial.agencyWebhookConfigId))
      .limit(1);

    res.json({ ...trial, agencyName: config?.agencyName ?? null, agencyCode: config?.agencyCode ?? null });
  });

  /** POST /agency/trial/:trialId/upgrade */
  router.post("/agency/trial/:trialId/upgrade", async (req, res) => {
    assertBoard(req);
    const { trialId } = req.params;

    const [trial] = await db
      .select({
        id: agencyTrials.id,
        trialStatus: agencyTrials.trialStatus,
        contactEmail: agencyTrials.contactEmail,
        contactName: agencyTrials.contactName,
        incidentCount: agencyTrials.incidentCount,
        incidentCap: agencyTrials.incidentCap,
        trialEndsAt: agencyTrials.trialEndsAt,
        agencyWebhookConfigId: agencyTrials.agencyWebhookConfigId,
      })
      .from(agencyTrials)
      .where(eq(agencyTrials.id, trialId))
      .limit(1);

    if (!trial) throw notFound("Trial not found");

    if (trial.trialStatus === "converted") {
      res.json({ already: true, message: "Trial already converted to paid." });
      return;
    }
    if (trial.trialStatus === "cancelled") {
      res.status(422).json({ error: "Trial is cancelled and cannot be upgraded." });
      return;
    }

    await db
      .update(agencyTrials)
      .set({ trialStatus: "converted", upgradedAt: new Date(), updatedAt: new Date() })
      .where(eq(agencyTrials.id, trialId));

    // Mark trial company as active
    const [config] = await db
      .select({
        agencyName: agencyWebhookConfigs.agencyName,
        agencyCode: agencyWebhookConfigs.agencyCode,
        companyId: agencyWebhookConfigs.companyId,
      })
      .from(agencyWebhookConfigs)
      .where(eq(agencyWebhookConfigs.id, trial.agencyWebhookConfigId))
      .limit(1);

    if (config) {
      await db
        .update(companies)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(companies.id, config.companyId));

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      emailClient
        .sendUpgradeConfirmation({
          trialId,
          contactEmail: trial.contactEmail,
          contactName: trial.contactName,
          agencyName: config.agencyName,
          agencyCode: config.agencyCode,
          webhookUrl: `${baseUrl}/api/cad/webhook`,
          trialEndsAt: trial.trialEndsAt,
          incidentCount: trial.incidentCount,
          incidentCap: trial.incidentCap,
        })
        .then(() =>
          db
            .insert(agencyTrialEmails)
            .values({ trialId, emailType: "upgrade_confirmation" })
            .catch(() => {}),
        )
        .catch((err: Error) =>
          console.warn("[agency-trial] upgrade email failed:", err.message),
        );
    }

    res.json({ upgraded: true, trialId });
  });

  return router;
}
