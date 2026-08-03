import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import {
  FINANCE_EVENT_KINDS,
  portfolioService,
  type FinanceEventKind,
} from "../services/portfolio.js";
import { assertAuthenticated, assertPortfolioAccess } from "./authz.js";

const FINANCE_EVENT_FIELDS = [
  "company_id",
  "event_id",
  "occurred_at",
  "kind",
  "channel",
  "amount_cents",
  "currency",
  "sku",
  "source_ref",
  "agent_id",
] as const;

function parseDateParam(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`Missing ${field} query value`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(`Invalid ${field} query value`);
  }
  return parsed;
}

function parseCompanyIds(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest("Missing companyIds query value");
  }
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw badRequest("Missing companyIds query value");
  }
  return Array.from(new Set(ids));
}

function parseKinds(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const kinds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (kinds.length === 0) return undefined;
  for (const kind of kinds) {
    if (!FINANCE_EVENT_KINDS.includes(kind as FinanceEventKind)) {
      throw badRequest(
        `Invalid kind: ${kind}. Allowed: ${FINANCE_EVENT_KINDS.join(", ")}`,
      );
    }
  }
  return kinds;
}

function parseLimit(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badRequest("Invalid limit query value");
  }
  return parsed;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`Missing ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw badRequest(`${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function portfolioRoutes(db: Db) {
  const router = Router();
  const svc = portfolioService(db);

  router.get("/portfolio/runs", async (req, res) => {
    const since = parseDateParam(req.query.since, "since");
    const until = parseDateParam(req.query.until, "until");
    if (until <= since) {
      throw badRequest("until must be after since");
    }
    const companyIds = parseCompanyIds(req.query.companyIds);
    assertPortfolioAccess(req, companyIds);

    const rows = await svc.listRunsRollup({
      actor: req.actor,
      since,
      until,
      companyIds,
    });

    res.json({
      schema: {
        version: "v1",
        window: {
          from: since.toISOString(),
          to: until.toISOString(),
        },
        fields: [
          "company_id",
          "agent_id",
          "runs_total",
          "runs_succeeded",
          "runs_failed",
          "seconds_on_task",
          "distinct_issues",
          "heartbeats_avg",
          "cost_cents",
          "priced_cost_event_count",
          "unpriced_cost_event_count",
        ],
      },
      rows,
    });
  });

  router.get("/portfolio/finance_events", async (req, res) => {
    const since = parseDateParam(req.query.since, "since");
    const until = parseDateParam(req.query.until, "until");
    if (until <= since) {
      throw badRequest("until must be after since");
    }
    const companyIds = parseCompanyIds(req.query.companyIds);
    const kinds = parseKinds(req.query.kinds);
    const limit = parseLimit(req.query.limit);
    assertPortfolioAccess(req, companyIds);

    const rows = await svc.listFinanceEvents({
      actor: req.actor,
      since,
      until,
      companyIds,
      kinds,
      limit,
    });

    res.json({
      schema: {
        version: "v1",
        window: {
          from: since.toISOString(),
          to: until.toISOString(),
        },
        fields: [...FINANCE_EVENT_FIELDS],
      },
      rows,
    });
  });

  router.post("/portfolio/finance_events", async (req, res) => {
    assertAuthenticated(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const companyId = requireString(body.company_id ?? body.companyId, "company_id");
    const kindRaw = requireString(body.kind, "kind");
    if (!FINANCE_EVENT_KINDS.includes(kindRaw as FinanceEventKind)) {
      throw badRequest(
        `Invalid kind: ${kindRaw}. Allowed: ${FINANCE_EVENT_KINDS.join(", ")}`,
      );
    }
    const channel = requireString(body.channel, "channel");
    const occurredAtRaw = requireString(body.occurred_at ?? body.occurredAt, "occurred_at");
    const occurredAt = new Date(occurredAtRaw);
    if (Number.isNaN(occurredAt.getTime())) {
      throw badRequest("Invalid occurred_at");
    }

    const amountRaw = body.amount_cents ?? body.amountCents;
    if (typeof amountRaw !== "number" || !Number.isFinite(amountRaw)) {
      throw badRequest("amount_cents must be a number");
    }

    const result = await svc.insertFinanceEvent({
      actor: req.actor,
      companyId,
      kind: kindRaw as FinanceEventKind,
      channel,
      occurredAt,
      amountCents: amountRaw,
      currency: optionalString(body.currency, "currency"),
      sku: optionalString(body.sku, "sku") ?? null,
      sourceRef: optionalString(body.source_ref ?? body.sourceRef, "source_ref") ?? null,
      agentId: optionalString(body.agent_id ?? body.agentId, "agent_id") ?? null,
      description: optionalString(body.description, "description") ?? null,
      metadata:
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : null,
    });

    res.status(result.created ? 201 : 200).json({
      schema: {
        version: "v1",
        fields: [...FINANCE_EVENT_FIELDS],
      },
      created: result.created,
      row: result.row,
    });
  });

  // OpCo intake-routing discovery (THIAAAAAA-113 / TSMC-10093). Any authenticated caller
  // (board/user session or agent JWT) may look up an OpCo's MC intake route by portfolio slug.
  // 404 for an unknown slug; the raw bearer is never returned (only a stable handle).
  router.get("/portfolio/companies/:slug", async (req, res) => {
    assertAuthenticated(req);
    const slug = requireString(req.params.slug, "slug");
    const entry = await svc.resolvePortfolioCompanyRegister(slug);
    if (!entry) {
      res.status(404).json({ error: "Company slug not found in portfolio register" });
      return;
    }
    const base = (process.env.PAPERCLIP_PUBLIC_URL || `${req.protocol}://${req.get("host") ?? ""}`)
      .replace(/\/+$/, "");
    res.json({
      slug: entry.slug,
      displayName: entry.displayName,
      intake: {
        url: `${base}/api/routine-triggers/public/${entry.triggerPublicId}/fire`,
        triggerPublicId: entry.triggerPublicId,
        bearerHandle: entry.bearerHandle,
      },
    });
  });

  return router;
}
