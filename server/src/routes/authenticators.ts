import { createHmac, randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents, companyAuthenticatorAgents, companyAuthenticators, companySecretBindings } from "@paperclipai/db";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { accessService, logActivity, secretService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo, requirePermission } from "./authz.js";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  secret: z.string().min(8),
  issuer: z.string().max(120).optional().nullable(),
  accountName: z.string().max(240).optional().nullable(),
  agentIds: z.array(z.string().uuid()).optional().default([]),
});
const bindSchema = z.object({ agentIds: z.array(z.string().uuid()) });

function authenticatorCodePath(authenticatorId: string) {
  return `authenticators.${authenticatorId}.code`;
}

export async function replaceAgentBindings(
  db: Db,
  record: typeof companyAuthenticators.$inferSelect,
  agentIds: string[],
) {
  const configPath = authenticatorCodePath(record.id);
  await db.transaction(async (tx) => {
    await tx.delete(companyAuthenticatorAgents).where(eq(companyAuthenticatorAgents.authenticatorId, record.id));
    await tx.delete(companySecretBindings).where(and(
      eq(companySecretBindings.companyId, record.companyId),
      eq(companySecretBindings.secretId, record.secretId),
      eq(companySecretBindings.targetType, "agent"),
      eq(companySecretBindings.configPath, configPath),
    ));
    if (agentIds.length === 0) return;
    await tx.insert(companyAuthenticatorAgents).values(agentIds.map((agentId) => ({
      companyId: record.companyId,
      authenticatorId: record.id,
      agentId,
    })));
    await tx.insert(companySecretBindings).values(agentIds.map((agentId) => ({
      companyId: record.companyId,
      secretId: record.secretId,
      targetType: "agent",
      targetId: agentId,
      configPath,
      versionSelector: "latest",
      required: true,
      label: record.name,
    })));
  });
}

function parseTotpInput(raw: string) {
  const value = raw.trim();
  if (value.startsWith("otpauth://")) {
    const url = new URL(value);
    if (url.protocol !== "otpauth:" || url.hostname !== "totp") throw unprocessable("Only TOTP authenticator URIs are supported");
    const secret = url.searchParams.get("secret")?.replace(/\s+/g, "").toUpperCase();
    if (!secret) throw unprocessable("Authenticator URI is missing a secret");
    const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase().replaceAll("-", "");
    const digits = Number.parseInt(url.searchParams.get("digits") ?? "6", 10);
    const period = Number.parseInt(url.searchParams.get("period") ?? "30", 10);
    if (algorithm !== "SHA1" || digits !== 6 || period !== 30) {
      throw unprocessable("The native authenticator vault currently supports 6-digit SHA1 TOTP codes with a 30-second period");
    }
    const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const split = label.indexOf(":");
    return {
      secret,
      issuer: url.searchParams.get("issuer") ?? (split >= 0 ? label.slice(0, split) : null),
      accountName: split >= 0 ? label.slice(split + 1) : label || null,
    };
  }
  const secret = value.replace(/[\s-]+/g, "").toUpperCase();
  if (!/^[A-Z2-7]+=*$/.test(secret)) throw unprocessable("TOTP seed must be Base32 or an otpauth URI");
  return { secret, issuer: null, accountName: null };
}

function decodeBase32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw unprocessable("Invalid Base32 TOTP seed");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function currentTotp(seed: string, now = Date.now()) {
  const counter = Math.floor(now / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(seed)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return { code, expiresAt: new Date((counter + 1) * 30_000).toISOString() };
}

export function authenticatorRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const secrets = secretService(db);

  router.get("/companies/:companyId/authenticators", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    let records = await db.select().from(companyAuthenticators).where(eq(companyAuthenticators.companyId, companyId));
    const bindings = await db.select().from(companyAuthenticatorAgents).where(eq(companyAuthenticatorAgents.companyId, companyId));
    if (actor.actorType === "agent") {
      const assignedIds = new Set(bindings.filter((binding) => binding.agentId === actor.agentId).map((binding) => binding.authenticatorId));
      records = records.filter((record) => assignedIds.has(record.id));
    } else {
      await requirePermission(req, access, companyId, "secrets:manage");
    }
    res.json(records.map(({ secretId: _secretId, ...record }) => ({
      ...record,
      agentIds: bindings.filter((binding) => binding.authenticatorId === record.id).map((binding) => binding.agentId),
    })));
  });

  router.post("/companies/:companyId/authenticators", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requirePermission(req, access, companyId, "secrets:manage");
    const input = createSchema.parse(req.body);
    const parsed = parseTotpInput(input.secret);
    const actor = getActorInfo(req);
    const secret = await secrets.create(companyId, {
      name: `authenticator-${input.name}-${randomUUID()}`,
      key: `totp_${randomUUID().replaceAll("-", "")}`,
      provider: "local_encrypted",
      value: parsed.secret,
      description: `Encrypted TOTP seed for ${input.name}`,
    }, { userId: actor.actorType === "user" ? actor.actorId : null, agentId: actor.agentId });
    const [record] = await db.insert(companyAuthenticators).values({
      companyId,
      name: input.name,
      issuer: input.issuer ?? parsed.issuer,
      accountName: input.accountName ?? parsed.accountName,
      secretId: secret.id,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    }).returning();
    if (input.agentIds.length > 0) {
      const valid = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, input.agentIds)));
      await replaceAgentBindings(db, record!, valid.map((agent) => agent.id));
    }
    res.status(201).json({ ...record, secretId: undefined, agentIds: input.agentIds });
  });

  router.put("/authenticators/:id/agents", async (req, res) => {
    const input = bindSchema.parse(req.body);
    const record = await db.select().from(companyAuthenticators).where(eq(companyAuthenticators.id, req.params.id as string)).then((rows) => rows[0] ?? null);
    if (!record) throw notFound("Authenticator not found");
    await requirePermission(req, access, record.companyId, "secrets:manage");
    const valid = input.agentIds.length === 0 ? [] : await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, record.companyId), inArray(agents.id, input.agentIds)));
    await replaceAgentBindings(db, record, valid.map((agent) => agent.id));
    res.json({ ok: true, agentIds: valid.map((agent) => agent.id) });
  });

  router.post("/authenticators/:id/code", async (req, res) => {
    const record = await db.select().from(companyAuthenticators).where(eq(companyAuthenticators.id, req.params.id as string)).then((rows) => rows[0] ?? null);
    if (!record) throw notFound("Authenticator not found");
    assertCompanyAccess(req, record.companyId);
    const actor = getActorInfo(req);
    if (actor.actorType === "agent") {
      const binding = await db.select({ id: companyAuthenticatorAgents.id }).from(companyAuthenticatorAgents).where(and(eq(companyAuthenticatorAgents.authenticatorId, record.id), eq(companyAuthenticatorAgents.agentId, actor.agentId!))).then((rows) => rows[0] ?? null);
      if (!binding) throw forbidden("Authenticator is not bound to this agent");
    } else {
      await requirePermission(req, access, record.companyId, "secrets:manage");
    }
    const seed = await secrets.resolveSecretValue(record.companyId, record.secretId, "latest", actor.actorType === "agent" ? {
      consumerType: "agent",
      consumerId: actor.agentId!,
      configPath: authenticatorCodePath(record.id),
      actorType: actor.actorType,
      actorId: actor.actorId,
      issueId: typeof req.body?.issueId === "string" ? req.body.issueId : null,
      heartbeatRunId: typeof req.body?.runId === "string" ? req.body.runId : null,
    } : undefined);
    const generated = currentTotp(seed);
    await logActivity(db, { companyId: record.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, action: "authenticator.code_generated", entityType: "company_authenticator", entityId: record.id, details: { issueId: req.body?.issueId ?? null, expiresAt: generated.expiresAt } });
    res.json(generated);
  });

  return router;
}
