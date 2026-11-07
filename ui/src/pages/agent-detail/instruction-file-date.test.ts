import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { instructionFileDateLabel } from "./instruction-file-date";

describe("Identity file dates", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(async () => { await i18n.changeLanguage("en"); });
  it("uses recorded creation until a modification date exists", () => {
    const createdAt = "2026-11-01T12:00:00.000Z";
    expect(instructionFileDateLabel({ createdAt })).toMatch(/^Date created /);
    expect(instructionFileDateLabel({ createdAt, updatedAt: "2026-11-02T12:00:00.000Z" })).toMatch(/^Last updated /);
  });
  it("localizes date descriptions and preserves metadata precedence", async () => {
    await i18n.changeLanguage("zh-CN");
    const createdAt = "2026-11-01T12:00:00.000Z";
    expect(instructionFileDateLabel({ createdAt })).toMatch(/^创建日期 /);
    expect(instructionFileDateLabel({ createdAt, updatedAt: "2026-11-02T12:00:00.000Z" })).toMatch(/^上次更新于 /);
    expect(instructionFileDateLabel({ createdAt, updatedAt: "invalid" })).toMatch(/^创建日期 /);
    expect(instructionFileDateLabel(null)).toBe("日期不可用");
    expect(instructionFileDateLabel({ createdAt: "invalid", updatedAt: "invalid" })).toBe("日期不可用");
  });
  it("does not fabricate dates for old or invalid metadata", () => {
    expect(instructionFileDateLabel(null)).toBe("Date unavailable");
    expect(instructionFileDateLabel({ updatedAt: "invalid" })).toBe("Date unavailable");
  });
});
