import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { listResponsibilitiesQuerySchema } from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import {
  authorizationDeniedDetails,
  issueReadSqlCondition,
  projectReadSqlCondition,
} from "../services/authorization.js";
import { accessService, instanceSettingsService } from "../services/index.js";
import { responsibilityService, type ResponsibilityReadScope } from "../services/responsibilities.js";
import {
  responsibilitySummaryService,
  type ResponsibilitySummaryServiceOptions,
} from "../services/responsibility-summaries.js";
import { assertCompanyAccess, getAccessibleResource } from "./authz.js";

const NOT_FOUND = "Responsibility not found";
const summaryQuerySchema = listResponsibilitiesQuerySchema.pick({ ownerUserId: true });

/**
 * Read-only summary paragraphs for responsibilities (experimental,
 * `enableResponsibilities`). The access rules repeat the overview and detail
 * routes in `responsibilities.ts` exactly; reads log no activity.
 */
export function responsibilitySummaryRoutes(db: Db, opts: { summaries?: ResponsibilitySummaryServiceOptions } = {}) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);
  const responsibilities = responsibilityService(db);
  const summaries = responsibilitySummaryService(db, opts.summaries);

  async function assertResponsibilitiesEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw notFound("Responsibilities are not enabled");
  }

  async function assertCompanyRead(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden("Board or agent access required");
    if (req.actor.type !== "agent") return;
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(
        "Responsibilities are outside this agent's authorization boundary",
        authorizationDeniedDetails(decision),
      );
    }
  }

  async function readScope(req: Request): Promise<ResponsibilityReadScope> {
    const [issueReadCondition, projectReadCondition] = await Promise.all([
      issueReadSqlCondition(db, req.actor),
      projectReadSqlCondition(db, req.actor),
    ]);
    return { issueReadCondition, projectReadCondition };
  }

  router.get("/companies/:companyId/responsibilities/summary", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const query = summaryQuerySchema.parse(req.query);
    const ownerUserId = query.ownerUserId ?? (req.actor.type === "board" ? req.actor.userId : undefined);
    if (!ownerUserId) {
      throw unprocessable(req.actor.type === "agent"
        ? "ownerUserId is required: name the person whose responsibilities to summarize"
        : "ownerUserId is required");
    }
    const overview = await responsibilities.overview(companyId, ownerUserId, {
      includeLetGo: false,
      scope: await readScope(req),
    });
    res.json(await summaries.whereThingsStand({ companyId, overview, actor: req.actor }));
  });

  router.get("/responsibilities/:id/summary", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const row = await getAccessibleResource(req, res, responsibilities.getById(req.params.id as string), NOT_FOUND);
    if (!row) return;
    await assertCompanyRead(req, row.companyId);
    const detail = await responsibilities.detail(row, await readScope(req), { actor: req.actor });
    res.json(await summaries.affectingTheNumber({ detail, actor: req.actor }));
  });

  return router;
}
