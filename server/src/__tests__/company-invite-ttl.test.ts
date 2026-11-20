import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COMPANY_INVITE_TTL_HOURS,
  MIN_COMPANY_INVITE_TTL_HOURS,
  MAX_COMPANY_INVITE_TTL_HOURS,
  COMPANY_INVITE_TTL_HOURS_ENV_KEY,
  getCompanyInviteTtlHours,
  getCompanyInviteTtlMs,
  resetCompanyInviteTtlCacheForTests,
  loadConfig,
} from "../config.js";
import { logger } from "../middleware/logger.js";

describe("company invite TTL config helper", () => {
  beforeEach(() => {
    resetCompanyInviteTtlCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetCompanyInviteTtlCacheForTests();
    vi.restoreAllMocks();
  });

  it("uses the 72 hour default when the variable is unset", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, undefined);
    const warnSpy = vi.spyOn(logger, "warn");

    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(getCompanyInviteTtlMs()).toBe(72 * 60 * 60 * 1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reads a valid override (e.g. 168 hours)", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "168");
    const warnSpy = vi.spyOn(logger, "warn");

    expect(getCompanyInviteTtlHours()).toBe(168);
    expect(getCompanyInviteTtlMs()).toBe(168 * 60 * 60 * 1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace for valid numbers", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "  24  ");
    expect(getCompanyInviteTtlHours()).toBe(24);
    expect(getCompanyInviteTtlMs()).toBe(24 * 60 * 60 * 1000);
  });

  it("accepts valid boundary values 1 and 720", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, String(MIN_COMPANY_INVITE_TTL_HOURS));
    expect(getCompanyInviteTtlHours()).toBe(1);
    expect(getCompanyInviteTtlMs()).toBe(1 * 60 * 60 * 1000);

    resetCompanyInviteTtlCacheForTests();
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, String(MAX_COMPANY_INVITE_TTL_HOURS));
    expect(getCompanyInviteTtlHours()).toBe(720);
    expect(getCompanyInviteTtlMs()).toBe(720 * 60 * 60 * 1000);
  });

  it("falls back to 72 and logs a warning for invalid non-numeric strings", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "not-a-number");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(getCompanyInviteTtlMs()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS * 60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ value: "not-a-number", defaultHours: 72 }),
      expect.stringContaining("Invalid PAPERCLIP_INVITE_TTL_HOURS"),
    );
  });

  it("falls back to 72 and logs a warning for 0", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "0");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(getCompanyInviteTtlMs()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS * 60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to 72 and logs a warning for negative values", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "-24");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(getCompanyInviteTtlMs()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS * 60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to 72 and logs a warning for values greater than 720", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "721");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(getCompanyInviteTtlMs()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS * 60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to 72 and logs a warning for non-integer float values", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "12.5");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(getCompanyInviteTtlMs()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS * 60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to 72 and logs a warning for empty or whitespace-only values", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    resetCompanyInviteTtlCacheForTests();
    warnSpy.mockClear();
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "   ");
    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("logs a single warning when called repeatedly with the same invalid value", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "invalid");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(getCompanyInviteTtlHours()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS);
    expect(getCompanyInviteTtlMs()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS * 60 * 60 * 1000);
    expect(getCompanyInviteTtlMs()).toBe(DEFAULT_COMPANY_INVITE_TTL_HOURS * 60 * 60 * 1000);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicit env map", () => {
    expect(getCompanyInviteTtlHours({ PAPERCLIP_INVITE_TTL_HOURS: "48" })).toBe(48);
    expect(getCompanyInviteTtlMs({ PAPERCLIP_INVITE_TTL_HOURS: "48" })).toBe(48 * 60 * 60 * 1000);
  });

  it("is exposed through loadConfig().companyInviteTtlHours", () => {
    vi.stubEnv(COMPANY_INVITE_TTL_HOURS_ENV_KEY, "120");
    expect(loadConfig().companyInviteTtlHours).toBe(120);
  });
});
