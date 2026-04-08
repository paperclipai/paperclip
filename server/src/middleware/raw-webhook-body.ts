import express, { type RequestHandler } from "express";
import { badRequest } from "../errors.js";

const BODY_LIMIT = "10mb";

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes("application/json") || normalized.includes("+json");
}

export function createRawWebhookBodyParser(): RequestHandler {
  const rawParser = express.raw({ type: "*/*", limit: BODY_LIMIT });

  return (req, res, next) => {
    rawParser(req, res, (error) => {
      if (error) {
        next(error);
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      (req as unknown as { rawBody: Buffer; rawBodyParsed: boolean }).rawBody = rawBody;
      (req as unknown as { rawBodyParsed: boolean }).rawBodyParsed = true;

      if (rawBody.length === 0) {
        req.body = undefined;
        next();
        return;
      }

      if (isJsonContentType(req.header("content-type"))) {
        try {
          req.body = JSON.parse(rawBody.toString("utf8"));
        } catch {
          next(badRequest("Invalid JSON body"));
          return;
        }
        next();
        return;
      }

      req.body = undefined;
      next();
    });
  };
}
