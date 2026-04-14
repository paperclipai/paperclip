import type { Request, RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { DEFAULT_LOCALE, type SupportedLocale } from "@paperclipai/shared";
import { matchSupportedLocale, pickSupportedLocaleFromAcceptLanguage, translateSystemMessage } from "@paperclipai/i18n";
import { instanceSettingsService, userPreferencesService } from "../services/index.js";

function readExplicitLocale(req: Request) {
  const queryLocale = typeof req.query.locale === "string" ? req.query.locale : null;
  return matchSupportedLocale(req.header("x-paperclip-locale") ?? queryLocale);
}

export function localeMiddleware(db: Db): RequestHandler {
  const instanceSettings = instanceSettingsService(db);
  const preferences = userPreferencesService(db);

  return async (req, res, next) => {
    try {
      const explicitLocale = readExplicitLocale(req);
      const userLocale =
        req.actor.type === "board" && req.actor.userId && req.actor.source !== "local_implicit"
          ? (await preferences.get(req.actor.userId)).locale
          : null;
      const instanceLocale = (await instanceSettings.getGeneral()).defaultLocale;
      const acceptedLocale = pickSupportedLocaleFromAcceptLanguage(req.header("accept-language"));
      const resolvedLocale: SupportedLocale =
        explicitLocale ?? userLocale ?? instanceLocale ?? acceptedLocale ?? DEFAULT_LOCALE;

      req.locale = resolvedLocale;
      res.setHeader("content-language", resolvedLocale);

      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (body && typeof body === "object" && !Array.isArray(body)) {
          const record = body as Record<string, unknown>;
          if (typeof record.error === "string") {
            return originalJson({
              ...record,
              error: translateSystemMessage(resolvedLocale, record.error),
            });
          }
        }
        return originalJson(body);
      }) as typeof res.json;

      next();
    } catch (err) {
      next(err);
    }
  };
}
