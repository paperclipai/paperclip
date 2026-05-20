// LET-514 — EAOS onboarding Slack safe install preview route.
//
// Companion to the LET-513 "Connect Slack" card on the EAOS onboarding Next
// Steps panel. Exposes a single read-only endpoint that returns the
// server-canonical preview of what the Slack capability install would look
// like, plus a deep link to the canonical capability-apply approval card if
// the company already has at least one agent.
//
// Safety contract:
//   - Read-only. No DB writes. No outbound network. No agent config mutation.
//   - No raw secrets, OAuth codes, or signing values ever flow through the
//     handler. The preview surfaces only env-style secret *names*.
//   - Catalog id is `verified/slack-app`, which passes the LET-402
//     `DefaultCatalogAllowlist` `verified/` prefix check. The same gate that
//     protects the live capability-apply adapter also protects this preview
//     — any future tightening of the allowlist will land here without code
//     changes.
//   - `approvalCardPath` is null when the company has no agent yet — the
//     onboarding "bootstrap assistant" backend lands in a parallel issue.

import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import {
  buildSlackInstallPreview,
  SLACK_VERIFIED_CATALOG_ID,
  type SlackInstallPreview,
} from "../services/slack-install-preview.js";

export interface SlackInstallPreviewResponse {
  readonly preview: SlackInstallPreview;
  readonly allowlistedCatalogId: typeof SLACK_VERIFIED_CATALOG_ID;
  readonly approvalCardPath: string | null;
  readonly approvalCardAgentId: string | null;
  readonly liveApplyEnabled: false;
}

async function resolveBootstrapAgent(
  db: Db,
  companyId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId)))
    .orderBy(asc(agents.createdAt))
    .limit(1);
  return row ?? null;
}

export function eaosOnboardingRoutes(db: Db) {
  const router = Router();

  router.post(
    "/companies/:companyId/eaos/onboarding/slack-install-preview",
    async (req, res) => {
      const { companyId } = req.params as { companyId: string };
      assertCompanyAccess(req, companyId);

      const preview = buildSlackInstallPreview();
      const agent = await resolveBootstrapAgent(db, companyId);
      const approvalCardPath = agent
        ? `/companies/${companyId}/agents/${agent.id}/capability-apply`
        : null;

      const response: SlackInstallPreviewResponse = {
        preview,
        allowlistedCatalogId: SLACK_VERIFIED_CATALOG_ID,
        approvalCardPath,
        approvalCardAgentId: agent?.id ?? null,
        liveApplyEnabled: false,
      };
      res.status(200).json(response);
    },
  );

  return router;
}
