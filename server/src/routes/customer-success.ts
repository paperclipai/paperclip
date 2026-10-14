import { createPublicKey, verify } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  canonicalJson,
  parseInspectionQuery,
  INSPECTION_AUDIENCE,
  INSPECTION_PERMIT_TYPE,
  INSPECTION_HEADER,
  type InspectionPermit,
} from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { getCloudRuntimeIdentity } from "../services/cloud-runtime-identity.js";
import { customerSuccessRunAuthority } from "../services/customer-success-authority.js";
import { readCustomerSuccessResource } from "../services/customer-success-inspection.js";
import { forbidden, unprocessable } from "../errors.js";

export function verifyInspectionPermit(
  token: string,
  keys: { keys: Array<Record<string, unknown>> },
  stackId: string,
  now = Date.now(),
): InspectionPermit {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 16384) throw forbidden("Invalid inspection permit");
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as InspectionPermit;
    const jwk = keys.keys.find(
      (k) => k.kid === header.kid && k.kty === "OKP" && k.crv === "Ed25519" && !k.d,
    );
    if (
      header.alg !== "EdDSA" ||
      header.typ !== INSPECTION_PERMIT_TYPE ||
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
      claims.v !== 1 ||
      claims.iss !== "paperclip-cloud" ||
      claims.aud !== INSPECTION_AUDIENCE ||
      claims.sub !== stackId ||
      !Number.isInteger(claims.iat) ||
      !Number.isInteger(claims.exp) ||
      claims.exp <= seconds ||
      claims.iat > seconds + 5 ||
      claims.exp - claims.iat > 60 ||
      claims.exp <= claims.iat ||
      !claims.jti ||
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

/** Mounted before actor middleware: none of these reads creates tenant state. */
export function customerSuccessRoutes(db: Db, storage: StorageService) {
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
  router.post("/read", async (req, res) => {
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
    // Replay fencing and all inspection state live in Cloud. No tenant receipt.
    const consumed = await fetch(`${origin}/v1/customer-success/permits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [INSPECTION_HEADER]: token },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!consumed.ok) throw forbidden("Inspection permit could not be consumed");
    const result = await readCustomerSuccessResource(db, storage, query);
    const body = JSON.stringify(result);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024)
      throw unprocessable("Inspection response is too large; use pagination or a byte range");
    res.type("application/json").send(body);
  });
  // Unknown methods/paths terminate here rather than entering normal auth.
  router.use((_req, res) => {
    res.status(404).json({ error: "Unsupported inspection endpoint" });
  });
  return router;
}
