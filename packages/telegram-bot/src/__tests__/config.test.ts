import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEEKLY_DIGEST_ROUTINE_ID,
  loadConfig,
} from "../config.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  TELEGRAM_BOT_TOKEN: "tok",
  PAPERCLIP_API_URL: "http://localhost:3100",
  PAPERCLIP_BOT_API_KEY: "key",
  PAPERCLIP_COMPANY_ID: "co",
  TELEGRAM_BOT_INTERNAL_SECRET: "secret",
  DINAR_USER_ID: "dinar-uuid",
  DINAR_TG_CHAT_ID: "-1003986807361",
};

describe("loadConfig.weeklyDigestRoutineId", () => {
  it("falls back to the production default when env is unset", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.notifier?.weeklyDigestRoutineId).toBe(DEFAULT_WEEKLY_DIGEST_ROUTINE_ID);
  });

  it("falls back to the production default when env is empty string", () => {
    const cfg = loadConfig({ ...BASE_ENV, CEO_WEEKLY_DIGEST_ROUTINE_ID: "   " });
    expect(cfg.notifier?.weeklyDigestRoutineId).toBe(DEFAULT_WEEKLY_DIGEST_ROUTINE_ID);
  });

  it("uses an explicit env override when provided", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      CEO_WEEKLY_DIGEST_ROUTINE_ID: "abc-staging-routine",
    });
    expect(cfg.notifier?.weeklyDigestRoutineId).toBe("abc-staging-routine");
  });

  it("treats CEO_WEEKLY_DIGEST_ROUTINE_ID=disabled as opt-out", () => {
    const cfg = loadConfig({ ...BASE_ENV, CEO_WEEKLY_DIGEST_ROUTINE_ID: "disabled" });
    expect(cfg.notifier?.weeklyDigestRoutineId).toBeUndefined();
  });
});
