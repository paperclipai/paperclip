import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  badRequest,
  payloadTooLarge,
  unsupportedMediaType,
} from "../errors.js";
import {
  CHAT_WEBHOOK_BODY_LIMIT,
  CHAT_WEBHOOK_BODY_LIMIT_BYTES,
} from "../http/body-limits.js";

const rawBodyParser = express.raw({
  inflate: false,
  limit: CHAT_WEBHOOK_BODY_LIMIT,
  type: "*/*",
});

type BodyParserError = Error & {
  status?: number;
  type?: string;
};

function bodyTooLarge() {
  return payloadTooLarge("Chat webhook request body is too large", {
    code: "chat_webhook_body_too_large",
    maxBytes: CHAT_WEBHOOK_BODY_LIMIT_BYTES,
  });
}

function parseContentLength(req: Request): bigint | null {
  const value = req.headers["content-length"];
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw badRequest("Invalid Content-Length header", {
      code: "chat_webhook_content_length_invalid",
    });
  }
  return BigInt(value);
}

/**
 * Preserve provider-signed request bytes while bounding unauthenticated ingress.
 * A declared oversized body is rejected before it is read. Requests without a
 * Content-Length header remain supported, but the streaming raw parser stops at
 * the same limit instead of falling through to the generic 10 MB API parser.
 */
export const chatWebhookBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let contentLength: bigint | null;
  try {
    contentLength = parseContentLength(req);
  } catch (error) {
    req.resume();
    next(error);
    return;
  }

  if (
    contentLength !== null &&
    contentLength > BigInt(CHAT_WEBHOOK_BODY_LIMIT_BYTES)
  ) {
    next(bodyTooLarge());
    return;
  }

  rawBodyParser(req, res, (error?: unknown) => {
    if (!error) {
      next();
      return;
    }

    const parserError = error as BodyParserError;
    if (parserError.status === 413 || parserError.type === "entity.too.large") {
      next(bodyTooLarge());
      return;
    }
    if (parserError.type === "encoding.unsupported") {
      next(
        unsupportedMediaType("Encoded chat webhook bodies are not supported", {
          code: "chat_webhook_content_encoding_unsupported",
        }),
      );
      return;
    }
    next(error);
  });
};
