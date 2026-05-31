import type { Db } from "@paperclipai/db";
import { Router } from "express";
import { patchCompanyAwaitingHumanSettingsSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import {
  awaitingHumanSettingsService,
  companyService,
  logActivity,
  secretService,
} from "../services/index.js";
import { sendClickUpTransportTestMessage } from "../services/clickup-awaiting-human-transport.js";
import { unprocessable } from "../errors.js";

function trimNullable(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function companyAwaitingHumanSettingsRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const settings = awaitingHumanSettingsService(db);
  const companies = companyService(db);

  router.get("/", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as { companyId: string }).companyId;
    assertCompanyAccess(req, companyId);
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(await settings.get(companyId));
  });

  router.patch("/", validate(patchCompanyAwaitingHumanSettingsSchema), async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as { companyId: string }).companyId;
    assertCompanyAccess(req, companyId);
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const body = req.body;
    const actor = getActorInfo(req);
    const updated = await settings.update(companyId, body, {
      userId: req.actor.userId,
      agentId: actor.agentId,
    });
    const redactedBody = "clickupPersonalToken" in body && body.clickupPersonalToken != null
      ? { ...body, clickupPersonalToken: "[REDACTED]" }
      : body;
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.awaiting_human_settings.updated",
      entityType: "company",
      entityId: companyId,
      details: redactedBody,
    });
    res.json(updated);
  });

  router.post("/connection-test", validate(patchCompanyAwaitingHumanSettingsSchema), async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as { companyId: string }).companyId;
    assertCompanyAccess(req, companyId);
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const body = req.body as {
      provider?: "clickup" | null;
      providerConfig?: { workspaceId: string | null; channelId: string | null } | null;
      clickupPersonalToken?: string | null;
    };
    const actor = getActorInfo(req);
    const stored = await settings.getStored(companyId);
    const storedConfig = stored?.provider === "clickup" ? stored.providerConfigJson : null;
    const storedToken = storedConfig?.authTokenRef?.secretId
      ? await secretService(db).resolveSecretValue(
        companyId,
        storedConfig.authTokenRef.secretId,
        storedConfig.authTokenRef.version ?? "latest",
      )
      : null;
    const provider = body.provider ?? stored?.provider ?? null;
    if (provider !== "clickup") {
      throw unprocessable("ClickUp connection tests require ClickUp to be selected");
    }

    const runtimeOverrides = {
      personalToken: trimNullable(body.clickupPersonalToken) ?? storedToken,
      workspaceId: body.providerConfig !== undefined
        ? body.providerConfig?.workspaceId ?? null
        : storedConfig?.workspaceId ?? null,
      channelId: body.providerConfig !== undefined
        ? body.providerConfig?.channelId ?? null
        : storedConfig?.channelId ?? null,
    };

    const result = await sendClickUpTransportTestMessage({
      title: `${company.name} ClickUp bridge connection test`,
      summary: "Bizbox completed a bridge transport test for ClickUp.",
      body: "The configured bridge successfully delivered a test payload to the target ClickUp channel.",
      link: new URL("/company/settings/awaiting-human", process.env.BIZBOX_API_URL ?? "http://localhost:3100").toString(),
      cta: "No action is required.",
    }, runtimeOverrides);
    const publicResult = result.status === "sent"
      ? {
        ...result,
        detail: `ClickUp bridge connection test succeeded. Message delivered to configured channel${result.externalId ? ` (message ${result.externalId})` : ""}.`,
      }
      : result;

    const redactedBody = "clickupPersonalToken" in body && body.clickupPersonalToken != null
      ? { ...body, clickupPersonalToken: "[REDACTED]" }
      : body;
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.awaiting_human_settings.connection_tested",
      entityType: "company",
      entityId: companyId,
      details: {
        ...redactedBody,
        result: publicResult,
      },
    });
    res.json(publicResult);
  });

  return router;
}
