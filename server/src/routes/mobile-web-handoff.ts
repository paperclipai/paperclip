import { Router, type Request } from "express";
import * as z from "zod";
import type { Db } from "@paperclipai/db";
import type {
  CreateMobileWebHandoffRequest,
  MobileWebHandoffResponse,
} from "@paperclipai/shared";
import { agentService, companyService, mobileWebHandoffService } from "../services/index.js";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const createMobileWebHandoffBodySchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("onboarding"),
    companyId: z.string().trim().min(1).optional(),
    returnUrl: z.string().trim().url().optional(),
  }),
  z.object({
    target: z.literal("agent_configuration"),
    companyId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
  }),
]);

const ALLOWED_RETURN_URL = "clipios://onboarding-complete";

function requestBaseUrl(req: Request) {
  const forwardedProto = req.header("x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
  const host =
    req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  if (!host) return "";
  return `${proto}://${host}`;
}

function buildAbsoluteUrl(req: Request, path: string) {
  const baseUrl = requestBaseUrl(req);
  return baseUrl ? `${baseUrl}${path}` : path;
}

function buildAuthConsumePath(token: string) {
  const query = new URLSearchParams({ token });
  return `/auth/mobile-handoff?${query.toString()}`;
}

function buildPluginConsumePath(token: string) {
  const query = new URLSearchParams({ token });
  return `/api/auth/mobile-web-handoff/consume?${query.toString()}`;
}

function buildOnboardingTargetPath(issuePrefix: string | null | undefined) {
  return issuePrefix && issuePrefix.trim().length > 0
    ? `/${issuePrefix}/onboarding`
    : "/onboarding";
}

export function mobileWebHandoffRoutes(db: Db) {
  const router = Router();
  const companies = companyService(db);
  const agents = agentService(db);
  const handoffs = mobileWebHandoffService(db);

  router.post("/", async (req, res) => {
    assertBoard(req);
    const body = createMobileWebHandoffBodySchema.parse(req.body) as CreateMobileWebHandoffRequest;
    const userId = req.actor.userId;
    if (!userId) {
      throw badRequest("Missing board user");
    }

    let companyId: string | null = body.companyId ?? null;
    let targetPath = "/onboarding";

    if (body.target === "onboarding" && body.returnUrl && body.returnUrl !== ALLOWED_RETURN_URL) {
      throw badRequest("Unsupported returnUrl");
    }

    if (body.companyId) {
      const requestedCompanyId = body.companyId;
      companyId = requestedCompanyId;
      assertCompanyAccess(req, requestedCompanyId);
      const company = await companies.getById(requestedCompanyId);
      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }

      if (body.target === "onboarding") {
        targetPath = buildOnboardingTargetPath(company.issuePrefix);
        if (body.returnUrl) {
          const targetUrl = new URL(targetPath, "http://paperclip.local");
          targetUrl.searchParams.set("returnUrl", body.returnUrl);
          targetPath = `${targetUrl.pathname}${targetUrl.search}`;
        }
      } else {
        if (!body.agentId) {
          throw badRequest("Missing agentId");
        }
        const agentId = body.agentId;
        const agent = await agents.getById(agentId);
        if (!agent || agent.companyId !== requestedCompanyId) {
          res.status(404).json({ error: "Agent not found" });
          return;
        }
        targetPath = `/${company.issuePrefix}/agents/${agent.urlKey ?? agent.id}/configuration`;
      }
    }

    const handoff = await handoffs.create({
      userId,
      targetPath,
      companyId,
    });

    const payload: MobileWebHandoffResponse = {
      url: buildAbsoluteUrl(req, buildAuthConsumePath(handoff.token)),
      expiresAt: handoff.expiresAt.toISOString(),
    };
    res.json(payload);
  });

  return router;
}

export function mobileWebHandoffRedirectRoutes() {
  const router = Router();

  router.get("/auth/mobile-handoff", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!token) {
      res.status(400).send("Missing token");
      return;
    }
    res.redirect(302, buildPluginConsumePath(token));
  });

  return router;
}
