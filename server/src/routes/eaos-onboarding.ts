// LET-514 — EAOS onboarding Slack safe install preview + truthful connection state.
//
// Companion to the LET-513 "Connect Slack" card on the EAOS onboarding Next
// Steps panel. Exposes two endpoints:
//
//   POST /companies/:cid/eaos/onboarding/slack-install-preview
//     Returns the server-canonical preview of what installing the verified
//     Slack capability would look like, plus a deep link to the canonical
//     capability-apply approval card if the company already has a bootstrap
//     agent.
//
//   GET /companies/:cid/eaos/onboarding/slack-connection
//     Returns the truthful, *derived* Slack onboarding connection state for
//     this company. The state is computed by projecting the existing
//     capability-apply lifecycle (capability_apply_plans + capability_apply_steps
//     filtered to the verified Slack catalog id) into one of:
//       not_connected | pending_approval | applying | connected | partial | error
//     The "connected" reading is only ever produced from an `applied` plan —
//     the UI never fabricates connected status from anything weaker.
//
// Safety contract:
//   - Both endpoints are read-only. No DB writes. No outbound network. No
//     agent config mutation. No `capability.apply.live` flip.
//   - No raw secrets, OAuth codes, or signing values ever flow through any
//     handler. The preview surfaces only env-style secret *names*; the
//     connection-state endpoint reads plan state + identifiers only.
//   - Catalog id is `verified/slack-app`, which passes the LET-402
//     `DefaultCatalogAllowlist` `verified/` prefix check. The same gate that
//     protects the live capability-apply adapter also protects this preview.
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
import {
  resolveSlackConnectionState,
  type SlackConnectionState,
} from "../services/slack-connection-state.js";

export interface SlackInstallPreviewResponse {
  readonly preview: SlackInstallPreview;
  readonly allowlistedCatalogId: typeof SLACK_VERIFIED_CATALOG_ID;
  readonly approvalCardPath: string | null;
  readonly approvalCardAgentId: string | null;
  readonly liveApplyEnabled: false;
  readonly connectionState: SlackConnectionState;
}

export interface SlackConnectionResponse {
  readonly state: SlackConnectionState;
  readonly planId: string | null;
  readonly approvalId: string | null;
  readonly lastUpdatedAt: string | null;
  readonly approvalCardPath: string | null;
  readonly approvalCardAgentId: string | null;
  readonly requiredSecretNames: readonly string[];
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

      const [preview, agent, connection] = await Promise.all([
        Promise.resolve(buildSlackInstallPreview()),
        resolveBootstrapAgent(db, companyId),
        resolveSlackConnectionState(db, companyId),
      ]);
      const approvalCardPath = agent
        ? `/companies/${companyId}/agents/${agent.id}/capability-apply`
        : null;

      const response: SlackInstallPreviewResponse = {
        preview,
        allowlistedCatalogId: SLACK_VERIFIED_CATALOG_ID,
        approvalCardPath,
        approvalCardAgentId: agent?.id ?? null,
        liveApplyEnabled: false,
        connectionState: connection.state,
      };
      res.status(200).json(response);
    },
  );

  router.get(
    "/companies/:companyId/eaos/onboarding/slack-connection",
    async (req, res) => {
      const { companyId } = req.params as { companyId: string };
      assertCompanyAccess(req, companyId);

      const [agent, connection, preview] = await Promise.all([
        resolveBootstrapAgent(db, companyId),
        resolveSlackConnectionState(db, companyId),
        Promise.resolve(buildSlackInstallPreview()),
      ]);
      const approvalCardPath = agent
        ? `/companies/${companyId}/agents/${agent.id}/capability-apply`
        : null;

      const response: SlackConnectionResponse = {
        state: connection.state,
        planId: connection.planId,
        approvalId: connection.approvalId,
        lastUpdatedAt: connection.lastUpdatedAt,
        approvalCardPath,
        approvalCardAgentId: agent?.id ?? null,
        requiredSecretNames: preview.requiredSecretNames,
        liveApplyEnabled: false,
      };
      res.status(200).json(response);
    },
  );

  return router;
}
