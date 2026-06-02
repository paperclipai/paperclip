import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { registerCampaigns } from "./groups/campaigns.js";
import { registerInbox } from "./groups/inbox.js";
import { registerBlog } from "./groups/blog.js";
import { registerExperiments } from "./groups/experiments.js";
import { registerMentions } from "./groups/mentions.js";
import { registerCatalog } from "./groups/catalog.js";
import { registerMarketing } from "./groups/marketing.js";
import { registerYoutube } from "./groups/youtube.js";
import { registerTeam } from "./groups/team.js";
import { registerRenewals } from "./groups/renewals.js";
import { registerLinkedin } from "./groups/linkedin.js";
import { registerPipeline } from "./groups/pipeline.js";
import { registerRevenue } from "./groups/revenue.js";
import { registerResearch } from "./groups/research.js";
import { registerOps } from "./groups/ops.js";
import { registerMisc } from "./groups/misc.js";
import { registerJobs } from "./groups/jobs.js";

/**
 * AGNB consolidated routes — ported from the standalone All-Gas-No-Brakes
 * Next.js app into the Paperclip server. Data lives in the `agnb` Postgres
 * schema (migrated from Supabase `internal`). See docs/migration/AGNB_CONSOLIDATION.md.
 *
 * Each register* fn owns one route group (one file under ./groups). Add new
 * groups here as they are ported.
 */
export function agnbRoutes(db: Db) {
  const router = Router();
  registerCampaigns(router, db);
  registerInbox(router, db);
  registerBlog(router, db);
  registerExperiments(router, db);
  registerMentions(router, db);
  registerCatalog(router, db);
  registerMarketing(router, db);
  registerYoutube(router, db);
  registerTeam(router, db);
  registerRenewals(router, db);
  registerLinkedin(router, db);
  registerPipeline(router, db);
  registerRevenue(router, db);
  registerResearch(router, db);
  registerOps(router, db);
  registerMisc(router, db);
  registerJobs(router, db);
  return router;
}
