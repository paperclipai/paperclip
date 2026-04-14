import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_LOCALES } from "@paperclipai/shared";

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));
const mockUserPreferencesService = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
  userPreferencesService: () => mockUserPreferencesService,
}));

async function createApp(actor: any) {
  const [{ localeMiddleware, errorHandler }, { i18nRoutes }, { userPreferencesRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/i18n.js"),
    import("../routes/user-preferences.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(localeMiddleware({} as any));
  app.get("/api/fail", (_req, res) => {
    res.status(403).json({ error: "Forbidden" });
  });
  app.use("/api", i18nRoutes({} as any));
  app.use("/api", userPreferencesRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("i18n routes and locale middleware", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      defaultLocale: "en",
    });
    mockUserPreferencesService.get.mockResolvedValue({ locale: "fr-FR" });
    mockUserPreferencesService.update.mockResolvedValue({ locale: "ja-JP" });
  });

  it("translates known error payloads from an explicit locale header", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
    });

    const res = await request(app)
      .get("/api/fail")
      .set("x-paperclip-locale", "zh-CN");

    expect(res.status).toBe(403);
    expect(res.headers["content-language"]).toBe("zh-CN");
    expect(res.body).toEqual({ error: "已禁止" });
  });

  it("falls back to the saved user locale when no explicit locale is provided", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
    });

    const res = await request(app).get("/api/fail");

    expect(res.status).toBe(403);
    expect(res.headers["content-language"]).toBe("fr-FR");
    expect(res.body).toEqual({ error: "Interdit" });
  });

  it("returns locale config from the instance default settings", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ defaultLocale: "de-DE" });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
    });

    const res = await request(app).get("/api/i18n/config");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      defaultLocale: "de-DE",
      supportedLocales: [...SUPPORTED_LOCALES],
    });
  });

  it("persists user locale preferences for session-backed board users", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
    });

    const res = await request(app)
      .patch("/api/user/preferences")
      .send({ locale: "ja-JP" });

    expect(res.status).toBe(200);
    expect(mockUserPreferencesService.update).toHaveBeenCalledWith("user-1", { locale: "ja-JP" });
    expect(res.body).toEqual({ locale: "ja-JP" });
  });

  it("rejects local implicit sessions from user preference persistence with translated errors", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });

    const res = await request(app)
      .get("/api/user/preferences")
      .set("x-paperclip-locale", "zh-CN");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "当前会话无法使用用户偏好设置" });
  });
});
