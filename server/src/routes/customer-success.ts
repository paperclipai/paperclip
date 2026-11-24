import { createPublicKey, verify } from "node:crypto";
import { Router, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import type { Db } from "@paperclipai/db";
import {
  canonicalJson,
  inspectionReadPath,
  parseInspectionQuery,
  INSPECTION_READ_PATH,
  INSPECTION_AUDIENCE,
  INSPECTION_PERMIT_TYPE,
  INSPECTION_HEADER,
  type InspectionPermit,
  type InspectionQuery,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { getCloudRuntimeIdentity } from "../services/cloud-runtime-identity.js";
import { customerSuccessRunAuthority, customerSuccessRunLiveness } from "../services/customer-success-authority.js";
import { readCustomerSuccessResource, type CustomerSuccessInspectionOptions } from "../services/customer-success-inspection.js";
import { forbidden, unprocessable } from "../errors.js";

/** Cloud → home stack run-liveness question (see `customerSuccessRunLiveness`). */
export const RUN_LIVENESS_TYPE = "paperclip-inspection-liveness+jwt";
export const RUN_LIVENESS_AUDIENCE = "paperclip-customer-success-liveness/v1";
export interface RunLivenessQuestion {
  companyId: string;
  agentId: string;
  runId: string;
}
export interface RunLivenessClaims extends RunLivenessQuestion {
  v: 1;
  iss: "paperclip-cloud";
  aud: typeof RUN_LIVENESS_AUDIENCE;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies a Cloud-signed EdDSA JWS of one type and the claims every Cloud
 * question shares: version, issuer, audience, this stack as subject, and an
 * unexpired window of at most 60 seconds. Throws a plain error on any doubt.
 */
function verifyCloudJws<Claims extends { v: number; iss: string; aud: string; sub: string; jti: string; iat: number; exp: number }>(
  token: string,
  keys: { keys: Array<Record<string, unknown>> },
  expected: { typ: string; aud: string; stackId: string },
  now: number,
): Claims {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 16384) throw new Error();
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Claims;
  const jwk = keys.keys.find(
    (k) => k.kid === header.kid && k.kty === "OKP" && k.crv === "Ed25519" && !k.d,
  );
  if (
    header.alg !== "EdDSA" ||
    header.typ !== expected.typ ||
    !jwk ||
    !verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    )
  )
    throw new Error();
  const seconds = Math.floor(now / 1000);
  if (
    !claims ||
    claims.v !== 1 ||
    claims.iss !== "paperclip-cloud" ||
    claims.aud !== expected.aud ||
    claims.sub !== expected.stackId ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= seconds ||
    claims.iat > seconds + 5 ||
    claims.exp - claims.iat > 60 ||
    claims.exp <= claims.iat ||
    !claims.jti
  )
    throw new Error();
  return claims;
}

export function verifyInspectionPermit(
  token: string,
  keys: { keys: Array<Record<string, unknown>> },
  stackId: string,
  now = Date.now(),
): InspectionPermit {
  try {
    const claims = verifyCloudJws<InspectionPermit>(
      token,
      keys,
      { typ: INSPECTION_PERMIT_TYPE, aud: INSPECTION_AUDIENCE, stackId },
      now,
    );
    if (
      !claims.grantId ||
      !claims.requestId ||
      !claims.agentId ||
      !claims.keyId ||
      !claims.runId ||
      !Number.isSafeInteger(claims.bindingVersion)
    )
      throw new Error();
    parseInspectionQuery(claims.query);
    return claims;
  } catch {
    throw forbidden("Invalid inspection permit");
  }
}

export function verifyRunLivenessQuestion(
  token: string,
  keys: { keys: Array<Record<string, unknown>> },
  stackId: string,
  now = Date.now(),
): RunLivenessClaims {
  try {
    const claims = verifyCloudJws<RunLivenessClaims>(
      token,
      keys,
      { typ: RUN_LIVENESS_TYPE, aud: RUN_LIVENESS_AUDIENCE, stackId },
      now,
    );
    if (![claims.companyId, claims.agentId, claims.runId].every((id) => typeof id === "string" && UUID.test(id)))
      throw new Error();
    return claims;
  } catch {
    throw forbidden("Invalid run liveness question");
  }
}

export const MAX_INSPECTION_RESPONSE_BYTES = 2 * 1024 * 1024;

export function fitInspectionResponse(
  result: unknown,
  operation: InspectionQuery["operation"],
  offset: number,
  maxBytes = MAX_INSPECTION_RESPONSE_BYTES,
): string | null {
  const body = JSON.stringify(result);
  if (Buffer.byteLength(body) <= maxBytes) return body;
  if (operation !== "list") return null;
  const page = result as { items?: unknown; nextOffset?: unknown } | null;
  if (!page || !Array.isArray(page.items) || page.items.length < 2) return null;
  const items = page.items;
  let low = 0;
  let high = items.length - 1;
  let fitted: string | null = null;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const candidate = JSON.stringify({ ...page, items: items.slice(0, count), nextOffset: offset + count });
    if (Buffer.byteLength(candidate) <= maxBytes) {
      low = count;
      fitted = candidate;
    } else {
      high = count - 1;
    }
  }
  return fitted;
}

/** Mounted before actor middleware: none of these reads creates tenant state. */
export function customerSuccessRoutes(db: Db, storage: StorageService, options: CustomerSuccessInspectionOptions = {}) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/run-authority", async (req, res) => {
    if (process.env.PAPERCLIP_CUSTOMER_SUCCESS_AUTHORITY_ENABLED !== "true")
      throw forbidden("Run authority is disabled");
    if (req.headers.cookie) throw forbidden("Browser credentials are not run authority");
    const match = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/);
    if (!match) throw forbidden("Managed run bearer required");
    res.json(await customerSuccessRunAuthority(db, match[1]));
  });
  // `/read` serves the original query features; `/read-v2` also serves
  // count, order and view. Cloud picks the path from the query, so a tenant
  // without `/read-v2` answers 404 and Cloud fails closed.
  const read = async (req: ExpressRequest, res: ExpressResponse) => {
    if (process.env.PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_ENABLED !== "true")
      throw forbidden("Inspection is disabled");
    if (req.headers.authorization || req.headers.cookie)
      throw forbidden("Only a Cloud inspection permit is accepted");
    const stackId = getCloudRuntimeIdentity()?.stackId ?? process.env.PAPERCLIP_CLOUD_STACK_ID;
    const rawKeys = process.env.PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_JWKS;
    const origin = process.env.PAPERCLIP_CUSTOMER_SUCCESS_CLOUD_ORIGIN;
    const token = req.get(INSPECTION_HEADER);
    if (!stackId || !rawKeys || !origin || !token)
      throw forbidden("Inspection trust is unavailable");
    const url = new URL(origin);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )) ||
      url.origin !== origin
    )
      throw forbidden("Inspection trust is invalid");
    const permit = verifyInspectionPermit(token, JSON.parse(rawKeys), stackId);
    let query;
    try {
      query = parseInspectionQuery(req.body);
    } catch {
      throw unprocessable("Invalid inspection query");
    }
    if (canonicalJson(query) !== canonicalJson(permit.query))
      throw forbidden("Inspection parameters do not match permit");
    if (req.path === INSPECTION_READ_PATH && inspectionReadPath(query) !== INSPECTION_READ_PATH)
      throw forbidden("This inspection query needs the extended read path");
    // Replay fencing and all inspection state live in Cloud. No tenant receipt.
    const consumed = await fetch(`${origin}/v1/customer-success/permits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [INSPECTION_HEADER]: token },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!consumed.ok) throw forbidden("Inspection permit could not be consumed");
    const result = await readCustomerSuccessResource(db, storage, query, options);
    const body = fitInspectionResponse(result, query.operation, query.offset ?? 0);
    if (body === null)
      throw unprocessable("Inspection response is too large; use pagination or a byte range");
    res.type("application/json").send(body);
  };
  router.post("/read", read);
  router.post("/read-v2", read);
  // Cloud run liveness check for inspection authority. Cloud asks with its
  // own signed, stack-addressed, 60-second question; no agent credential,
  // identity key, actor, session or activity is involved.
  router.post("/run-liveness", async (req, res) => {
    if (process.env.PAPERCLIP_CUSTOMER_SUCCESS_AUTHORITY_ENABLED !== "true")
      throw forbidden("Run authority is disabled");
    if (req.headers.authorization || req.headers.cookie)
      throw forbidden("Only a Cloud run liveness question is accepted");
    const stackId = getCloudRuntimeIdentity()?.stackId ?? process.env.PAPERCLIP_CLOUD_STACK_ID;
    const rawKeys = process.env.PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_JWKS;
    const token = req.get(INSPECTION_HEADER);
    if (!stackId || !rawKeys || !token) throw forbidden("Inspection trust is unavailable");
    let keys: { keys: Array<Record<string, unknown>> };
    try {
      keys = JSON.parse(rawKeys);
    } catch {
      throw forbidden("Inspection trust is invalid");
    }
    const claims = verifyRunLivenessQuestion(token, keys, stackId);
    const question: RunLivenessQuestion = {
      companyId: claims.companyId,
      agentId: claims.agentId,
      runId: claims.runId,
    };
    if (canonicalJson(req.body ?? null) !== canonicalJson(question))
      throw forbidden("Run liveness parameters do not match the question");
    res.json({ version: 1, ...question, active: await customerSuccessRunLiveness(db, question) });
  });
  // Unknown methods/paths terminate here rather than entering normal auth.
  router.use((_req, res) => {
    res.status(404).json({ error: "Unsupported inspection endpoint" });
  });
  return router;
}
