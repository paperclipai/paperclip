import type { RequestHandler } from "express";
import { type TFunction } from "i18next";
import { getFixedT, supportedLanguages, type SupportedLanguage } from "../i18n/index.js";

declare global {
  namespace Express {
    interface Request {
      language: string;
      t: TFunction;
    }
  }
}

/**
 * Parse the Accept-Language header and return the best matching supported language.
 * Falls back to 'en' if no match is found.
 */
function parseAcceptLanguage(header: string | undefined): SupportedLanguage {
  if (!header) return "en";

  // Parse weighted language tags: en-US,en;q=0.9,es;q=0.8
  const languages = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const quality = qParam ? parseFloat(qParam.trim().substring(2)) : 1.0;
      return { tag: tag.trim().toLowerCase(), quality };
    })
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of languages) {
    // Exact match (e.g., "es")
    if (supportedLanguages.includes(tag as SupportedLanguage)) {
      return tag as SupportedLanguage;
    }
    // Prefix match (e.g., "es-MX" -> "es")
    const prefix = tag.split("-")[0];
    if (supportedLanguages.includes(prefix as SupportedLanguage)) {
      return prefix as SupportedLanguage;
    }
  }

  return "en";
}

/**
 * Express middleware that detects the client language from the Accept-Language header
 * and attaches `req.language` and `req.t` (translation function) to the request.
 */
export function i18nMiddleware(): RequestHandler {
  return (req, _res, next) => {
    const language = parseAcceptLanguage(req.header("accept-language"));
    req.language = language;
    req.t = getFixedT(language);
    next();
  };
}
