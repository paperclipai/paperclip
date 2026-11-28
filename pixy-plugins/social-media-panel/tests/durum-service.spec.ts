import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { issueFactory } from "./fixture.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_KEY = "sosyal-medya-durum";

const GECERLI_GOVDE = JSON.stringify({
  updatedAt: "2026-10-30T09:00:00Z",
  accounts: [
    {
      platform: "instagram",
      handle: "@pixydigital",
      followers: 1200,
      followersDelta30d: 42,
      engagementRate: 0.04,
      recentPosts: [{ title: "Kampanya", url: "https://instagram.com/p/1", publishedAt: "2026-10-12" }],
      recommendations: ["Haftada iki gönderi"],
    },
  ],
});

async function olustur(ayarlar: Record<string, unknown>): Promise<TestHarness> {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "issue.documents.write"],
    config: ayarlar,
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

async function durum(harness: TestHarness, companyId?: string): Promise<TestSonuc> {
  const sonuc = await harness.getData<unknown>("sosyal-medya-durum", companyId ? { companyId } : {});
  return sonuc as TestSonuc;
}

interface TestSonuc {
  status: string;
  reason?: string;
  source: { issueId: string | null; documentKey: string } | null;
  data?: { updatedAt: string | null; accounts: Array<{ platform: string; followers: number | null }> };
}

async function dokumanYaz(harness: TestHarness, issueId: string, companyId: string, body: string): Promise<void> {
  await harness.ctx.issues.documents.upsert({ companyId, issueId, key: DOCUMENT_KEY, body });
}

describe("sosyal-medya-durum veri işleyicisi", () => {
  it("ayarlanmış issue'ya bağlı dokümanı okur ve doğrulanmış veri döndürür", async () => {
    const harness = await olustur({ issueId: "issue-2" });
    harness.seed({ issues: [issueFactory("issue-1", COMPANY), issueFactory("issue-2", COMPANY)] });
    await dokumanYaz(harness, "issue-2", COMPANY, GECERLI_GOVDE);

    const sonuc = await durum(harness, COMPANY);
    expect(sonuc.status).toBe("ok");
    expect(sonuc.data?.accounts).toHaveLength(1);
    expect(sonuc.data?.accounts[0].platform).toBe("instagram");
    expect(sonuc.data?.accounts[0].followers).toBe(1200);
    expect(sonuc.data?.updatedAt).toBe("2026-10-30T09:00:00Z");
  });

  it("ayarlanmış issue yoksa not-found döndürür", async () => {
    const harness = await olustur({ issueId: "yok-gibi" });
    harness.seed({ issues: [issueFactory("issue-1", COMPANY)] });

    const sonuc = await durum(harness, COMPANY);
    expect(sonuc.status).toBe("not-found");
    expect(sonuc.reason).toContain("bulunamadı");
  });

  it("ayarlarda issue yoksa tüm issue'ları tarar ve dokümanı bulur", async () => {
    const harness = await olustur({});
    harness.seed({ issues: [issueFactory("issue-a", COMPANY), issueFactory("issue-b", COMPANY)] });
    await dokumanYaz(harness, "issue-a", COMPANY, GECERLI_GOVDE);

    const sonuc = await durum(harness, COMPANY);
    expect(sonuc.status).toBe("ok");
    expect(sonuc.source?.issueId).toBe("issue-a");
  });

  it("doküman hiçbir issue'da yoksa not-found döndürür", async () => {
    const harness = await olustur({});
    harness.seed({ issues: [issueFactory("issue-a", COMPANY)] });

    const sonuc = await durum(harness, COMPANY);
    expect(sonuc.status).toBe("not-found");
  });

  it("geçersiz gövdede invalid ve gerekçe döndürür", async () => {
    const harness = await olustur({ issueId: "issue-a" });
    harness.seed({ issues: [issueFactory("issue-a", COMPANY)] });
    await dokumanYaz(harness, "issue-a", COMPANY, "```json\n{hatalı}\n```");

    const sonuc = await durum(harness, COMPANY);
    expect(sonuc.status).toBe("invalid");
    expect(sonuc.reason?.length ?? 0).toBeGreaterThan(0);
  });

  it("tarihi ve hesapları boş veride empty durumunu döndürür", async () => {
    const harness = await olustur({ issueId: "issue-a" });
    harness.seed({ issues: [issueFactory("issue-a", COMPANY)] });
    await dokumanYaz(harness, "issue-a", COMPANY, JSON.stringify({ updatedAt: null, accounts: [] }));

    const sonuc = await durum(harness, COMPANY);
    expect(sonuc.status).toBe("empty");
  });

  it("başka şirkete ait dokümanı okumaz", async () => {
    const harness = await olustur({ issueId: "issue-x" });
    harness.seed({ issues: [issueFactory("issue-x", OTHER_COMPANY)] });
    await dokumanYaz(harness, "issue-x", OTHER_COMPANY, GECERLI_GOVDE);

    const sonuc = await durum(harness, COMPANY);
    expect(sonuc.status).toBe("not-found");
  });

  it("şirket çözülemezse no-company döndürür", async () => {
    const harness = await olustur({});

    const sonuc = await durum(harness);
    expect(sonuc.status).toBe("no-company");
  });
});

describe("plugin-config veri işleyicisi", () => {
  it("ayarları varsayılanlarla normalleştirir ve limiti kitler", async () => {
    const harness = await olustur({ scanLimit: 500 });

    const sonuc = await harness.getData<Record<string, unknown>>("plugin-config", { companyId: COMPANY });
    expect(sonuc).toMatchObject({
      issueId: null,
      documentKey: "sosyal-medya-durum",
      scanLimit: 100,
    });
  });
});
