import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import {
  companyWorkProjectionQuerySchema,
  createCompanyWorkProjectionCredentialSchema,
  type CompanyWorkProjectionResponse,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { HttpError, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyWorkProjectionService } from "../services/company-work-projection.js";
import { companyWorkProjectionCredentialService } from "../services/company-work-projection-credentials.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";

function splitEntityTags(header: string): string[] {
  const tags: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      tags.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  tags.push(header.slice(start).trim());
  return tags.filter(Boolean);
}

function weakEntityTag(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}

export function ifNoneMatchMatches(header: string | undefined, currentEtag: string): boolean {
  if (!header) return false;
  return splitEntityTags(header).some((candidate) => (
    candidate === "*" || weakEntityTag(candidate) === weakEntityTag(currentEtag)
  ));
}

export function companyWorkProjectionRoutes(
  db: Db,
  options: {
    readSnapshot?: (input: {
      companyId: string;
      credentialId: string;
      cursor?: string;
      pageSize?: number;
    }) => Promise<CompanyWorkProjectionResponse>;
  } = {},
) {
  const router = Router();
  const service = companyWorkProjectionService(db);
  const credentials = companyWorkProjectionCredentialService(db);
  const readSnapshot = options.readSnapshot ?? service.readSnapshot;

  router.get("/v1/companies/:companyId/work-projection", async (req, res, next) => {
    const companyId = req.params.companyId as string;
    if (req.actor.type === "none" && !req.actor.credentialId) {
      next(new HttpError(401, "Work projection credential required", {
        code: "WORK_PROJECTION_UNAUTHORIZED",
      }));
      return;
    }
    if (
      req.actor.type !== "none" ||
      req.actor.companyId !== companyId ||
      !req.actor.credentialId
    ) {
      next(forbidden("Work projection credential cannot access this company", {
        code: "WORK_PROJECTION_FORBIDDEN",
      }));
      return;
    }

    const query = companyWorkProjectionQuerySchema.safeParse(req.query);
    if (!query.success) {
      next(new HttpError(400, "Malformed work projection request", {
        code: "WORK_PROJECTION_MALFORMED",
      }));
      return;
    }

    try {
      const result = await readSnapshot({
        companyId,
        credentialId: req.actor.credentialId,
        cursor: query.data.cursor,
        pageSize: query.data.pageSize,
      });
      res.set({
        ETag: result.etag,
        "Cache-Control": "private, no-cache",
        Vary: "Authorization",
        "X-Paperclip-Api-Version": result.apiVersion,
        "X-Paperclip-Schema-Version": String(result.schemaVersion),
        "X-Paperclip-Snapshot-Revision": result.snapshot.revision,
      });
      if (ifNoneMatchMatches(req.header("if-none-match"), result.etag)) {
        res.status(304).end();
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 429) res.set("Retry-After", "1");
        next(error);
      } else {
        next(new HttpError(503, "Work projection is unavailable", {
          code: "WORK_PROJECTION_UNAVAILABLE",
        }));
      }
    }
  });

  async function requireCompany(req: Parameters<typeof assertCompanyAccess>[0], companyId: string) {
    assertBoard(req);
    const company = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company || !hasCompanyAccess(req, companyId)) throw notFound("Company not found");
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Work projection credential management requires company administration");
    return userId;
  }

  router.get("/v1/companies/:companyId/work-projection-credentials", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await requireCompany(req, companyId);
    res.json(await credentials.list(companyId, actorId));
  });

  router.post(
    "/v1/companies/:companyId/work-projection-credentials",
    validate(createCompanyWorkProjectionCredentialSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actorId = await requireCompany(req, companyId);
      const credential = await credentials.create(companyId, req.body.name, actorId);
      res.status(201).json(credential);
    },
  );

  router.delete("/v1/companies/:companyId/work-projection-credentials/:credentialId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await requireCompany(req, companyId);
    const credential = await credentials.revoke(
      companyId,
      req.params.credentialId as string,
      actorId,
    );
    if (!credential) throw notFound("Work projection credential not found");
    res.json(credential);
  });

  return router;
}
