import { afterEach, describe, expect, it } from "vitest";
import { describeCron } from "./cron-readable";
import { i18n } from "@/i18n";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("Russian cron descriptions", () => {
  it.each([
    ["*/1 * * * *", "Раз в 1 минуту"],
    ["*/2 * * * *", "Раз в 2 минуты"],
    ["*/5 * * * *", "Раз в 5 минут"],
    ["*/21 * * * *", "Раз в 21 минуту"],
    ["*/22 * * * *", "Раз в 22 минуты"],
    ["*/25 * * * *", "Раз в 25 минут"],
    ["0 9 * * 1-5", "По будням в 09:00"],
    ["30 9 * * 1", "По понедельникам в 09:30"],
    ["30 9 * * 1,3", "По понедельникам и средам в 09:30"],
  ])("describes %s without English plural fragments", async (cron, expected) => {
    await i18n.changeLanguage("ru");
    expect(describeCron(cron)).toBe(expected);
  });
});

describe("describeCron", () => {
  it("describes a daily time", () => {
    expect(describeCron("0 14 * * *")).toBe("Every day at 14:00");
  });

  it("describes every-weekday", () => {
    expect(describeCron("0 14 * * 1-5")).toBe("Every weekday at 14:00");
  });

  it("describes a single day-of-week", () => {
    expect(describeCron("30 9 * * 1")).toBe("Every Monday at 09:30");
  });

  it("describes every N minutes", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
  });

  it("describes hourly on a minute", () => {
    expect(describeCron("5 * * * *")).toBe("Every hour at :05");
  });

  it("returns null for empty or unparseable input", () => {
    expect(describeCron("")).toBeNull();
    expect(describeCron(undefined)).toBeNull();
    expect(describeCron("not a cron")).toBeNull();
    expect(describeCron("1 2 3")).toBeNull();
  });
});
