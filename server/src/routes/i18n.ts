import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { SUPPORTED_LOCALES } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/index.js";

export function i18nRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/i18n/config", async (_req, res) => {
    const general = await settings.getGeneral();
    res.json({
      defaultLocale: general.defaultLocale,
      supportedLocales: [...SUPPORTED_LOCALES],
    });
  });

  return router;
}
