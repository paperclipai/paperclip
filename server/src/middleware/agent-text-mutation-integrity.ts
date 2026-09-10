import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Request, RequestHandler } from "express";
import { badRequest } from "../errors.js";

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|\s*$)/i;
const CHARSET_PARAMETER = /(?:^|;)\s*charset\s*=\s*([^;\s]+)/i;
const CONTENT_DIGEST = /^sha-256=:([A-Za-z0-9+/]+={0,2}):$/;

/**
 * Agent-authenticated JSON POST/PATCH mutations must prove their exact raw
 * bytes. Board/browser and non-JSON mutations retain their existing contract.
 */
export const agentTextMutationContentType: RequestHandler = (req, res, next) => {
  const contentType = req.header("content-type");
  if (req.actor?.type !== "agent" || !["POST", "PATCH"].includes(req.method) || !contentType || !JSON_CONTENT_TYPE.test(contentType)) {
    return next();
  }
  const charset = contentType?.match(CHARSET_PARAMETER)?.[1]?.replace(/^['"]|['"]$/g, "").toLowerCase();
  if (charset !== "utf-8" && charset !== "utf8") {
    return res.status(428).json({ error: "Agent JSON mutations require Content-Type: application/json; charset=utf-8." });
  }
  return next();
};

/**
 * `express.json()` calls this while it still has the exact wire bytes and
 * before it decodes them.  Node's default UTF-8 decoding replaces malformed
 * input with U+FFFD, which makes a matching digest insufficient evidence that
 * text was safe to persist.
 */
export function captureAndValidateAgentTextMutationBody(req: IncomingMessage, rawBody: Uint8Array): void {
  // body-parser exposes a Buffer backed by ArrayBufferLike. Copying it into a
  // plain Buffer keeps the exact bytes while avoiding an unsafe generic cast
  // at the Express verifier boundary.
  const exactBytes = Buffer.from(rawBody);
  (req as IncomingMessage & { rawBody?: Buffer }).rawBody = exactBytes;
  if (!isAgentJsonMutation(req)) return;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(exactBytes);
  } catch {
    throw badRequest("Agent JSON mutations must contain valid UTF-8 bytes.");
  }
}

/**
 * Runs after JSON parsing, once the raw body is available for the digest and
 * semantic corruption checks. The content-type gate must run before parsing
 * so body-parser cannot turn a non-UTF-8 request into an unrelated 415.
 */
export const agentTextMutationIntegrity: RequestHandler = (req, res, next) => {
  const contentType = req.header("content-type");
  if (!isAgentJsonMutation(req)) {
    return next();
  }

  const expectedDigest = parseContentDigest(req.header("content-digest"));
  const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
  if (!expectedDigest || !rawBody || !safeEqual(expectedDigest, digest(rawBody))) {
    return res.status(400).json({ error: "Content-Digest must match the exact UTF-8 JSON request bytes." });
  }
  if (containsTextCorruptionMarker(req.body)) {
    return res.status(422).json({ error: "JSON mutation contains a text-encoding corruption marker (U+FFFD or four or more consecutive question marks)." });
  }
  return next();
};

function isAgentJsonMutation(req: IncomingMessage): boolean {
  const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined;
  const actor = (req as IncomingMessage & { actor?: { type?: string } }).actor;
  if (actor?.type !== "agent" || (req.method !== "POST" && req.method !== "PATCH") || !contentType) return false;
  return JSON_CONTENT_TYPE.test(contentType);
}

function containsTextCorruptionMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\uFFFD") || /\?{4,}/.test(value);
  if (Array.isArray(value)) return value.some(containsTextCorruptionMarker);
  if (value && typeof value === "object") return Object.values(value).some(containsTextCorruptionMarker);
  return false;
}

function parseContentDigest(value: string | undefined): Buffer | undefined {
  const encoded = value?.match(CONTENT_DIGEST)?.[1];
  if (!encoded) return undefined;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 32 ? decoded : undefined;
}

function digest(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
