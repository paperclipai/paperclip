import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  anthropicAccountsService,
  logActivity,
  type AnthropicAccountMode,
} from "../services/index.js";
import { unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const VALID_MODES: ReadonlySet<AnthropicAccountMode> = new Set([
  "oauth",
  "api_key",
  "bedrock",
]);

function parseMode(input: unknown): AnthropicAccountMode {
  if (typeof input !== "string" || !VALID_MODES.has(input as AnthropicAccountMode)) {
    throw unprocessable("mode must be one of oauth, api_key, bedrock");
  }
  return input as AnthropicAccountMode;
}

function parseLabel(input: unknown): string {
  if (typeof input !== "string") throw unprocessable("label must be a string");
  const trimmed = input.trim();
  if (trimmed.length === 0) throw unprocessable("label must not be empty");
  if (trimmed.length > 200) throw unprocessable("label must be 200 chars or fewer");
  return trimmed;
}

function parseOptionalString(input: unknown, field: string): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") throw unprocessable(`${field} must be a string`);
  const trimmed = input.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseAccountIdParam(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw unprocessable("Invalid account id");
  }
  return value;
}

export function anthropicAccountsRoutes(db: Db) {
  const router = Router();
  const svc = anthropicAccountsService(db);

  router.get("/companies/:companyId/anthropic-accounts", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const accounts = await svc.listAccounts(companyId);
    res.json(accounts);
  });

  router.post("/companies/:companyId/anthropic-accounts", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const label = parseLabel(req.body?.label);
    const mode = parseMode(req.body?.mode);
    const credentialDir = parseOptionalString(req.body?.credentialDir, "credentialDir");
    const apiKeySecretId = parseOptionalString(req.body?.apiKeySecretId, "apiKeySecretId");

    const created = await svc.createAccount({
      companyId,
      label,
      mode,
      credentialDir,
      apiKeySecretId,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "anthropic_account.created",
      entityType: "anthropic_account",
      entityId: created.id,
      details: { label: created.label, mode: created.mode },
    });

    res.status(201).json(created);
  });

  router.delete(
    "/companies/:companyId/anthropic-accounts/:id",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const accountId = parseAccountIdParam(req.params.id);
      assertCompanyAccess(req, companyId);

      const existing = await svc.getAccountById(accountId);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Anthropic account not found" });
        return;
      }

      await svc.deleteAccount(accountId);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "anthropic_account.deleted",
        entityType: "anthropic_account",
        entityId: accountId,
        details: { label: existing.label, mode: existing.mode },
      });

      res.json({ ok: true });
    },
  );

  router.get(
    "/companies/:companyId/anthropic-accounts/active",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const active = await svc.getActiveAccount(companyId);
      if (!active) {
        res.status(404).json({ error: "No active Anthropic account" });
        return;
      }
      res.json({
        accountId: active.account.id,
        setAt: active.setAt,
        setByAgentId: active.setByAgentId,
        setByUserId: active.setByUserId,
        account: active.account,
      });
    },
  );

  router.put(
    "/companies/:companyId/anthropic-accounts/active",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const accountId = parseAccountIdParam(req.body?.accountId);
      const actor = getActorInfo(req);
      const result = await svc.setActiveAccount(companyId, accountId, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "anthropic_account.activated",
        entityType: "anthropic_account",
        entityId: result.account.id,
        details: { label: result.account.label, mode: result.account.mode },
      });

      res.json({
        accountId: result.account.id,
        setAt: result.setAt,
        setByAgentId: result.setByAgentId,
        setByUserId: result.setByUserId,
        account: result.account,
      });
    },
  );

  return router;
}
