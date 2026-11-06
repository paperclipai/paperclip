// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import * as sdk from "@paperclipai/plugin-sdk/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SosyalMedyaPage } from "../src/ui/index.js";
import type { SosyalMedyaSnapshot } from "../src/types.js";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  useHostContext: vi.fn(() => ({ companyId: "c1", companyPrefix: "PAP", projectId: null, entityId: null, entityType: null, userId: "u1" })),
  useHostNavigation: vi.fn(() => ({ resolveHref: (to: string) => `/PAP${to}`, navigate: vi.fn(), linkProps: (to: string) => ({ href: `/PAP${to}`, onClick: vi.fn() }) })),
  usePluginData: vi.fn(),
  usePluginAction: vi.fn(),
  usePluginStream: vi.fn(),
  usePluginToast: vi.fn(),
  useHostLocation: vi.fn(),
  useSettingsConfig: vi.fn(),
}));

const mockBeta = sdk as unknown as {
  usePluginData: ReturnType<typeof vi.fn>;
  useHostContext: ReturnType<typeof vi.fn>;
};

function simulasyon(snap: SosyalMedyaSnapshot | { error: Error }) {
  mockBeta.useHostContext.mockReturnValue({ companyId: "c1", companyPrefix: "PAP", projectId: null, entityId: null, entityType: null, userId: "u1" });
  mockBeta.usePluginData.mockImplementation((key: string) => {
    if (key === "plugin-config") return { data: { issueId: null, documentKey: "sosyal-medya-durum", scanLimit: 30 }, loading: false, error: null };
    if ("error" in snap) return { data: null, loading: false, error: snap.error };
    return { data: snap, loading: false, error: null };
  });
}

const HESAPLI_SNAPSHOT: SosyalMedyaSnapshot = {
  status: "ok",
  data: {
    updatedAt: "2026-10-30T09:00:00Z",
    accounts: [
      {
        platform: "Instagram",
        handle: "@pixydigital",
        url: "https://instagram.com/pixydigital",
        followers: 1234,
        followersDelta30d: 42,
        engagementRate: 0.05,
        recentPosts: [{ title: "Kampanya", url: null, publishedAt: "2026-10-20" }],
        recommendations: ["Haftada iki gönderi"],
      },
    ],
  },
  uyarilar: [],
  source: { issueId: "issue-1", issueTitle: "Sosyal medya güncellemesi", documentKey: "sosyal-medya-durum" },
  scannedIssueCount: 3,
};

describe("SosyalMedyaPage", () => {
  beforeEach(() => {
    mockBeta.usePluginData.mockReset();
  });

  it("hesap kartını takipçi ve önerilerle gösterir", () => {
    simulasyon(HESAPLI_SNAPSHOT);
    render(<SosyalMedyaPage context={{ companyId: "c1", companyPrefix: "PAP", projectId: null, entityId: null, entityType: null, userId: "u1" }} />);

    expect(screen.getByText("Instagram")).toBeTruthy();
    expect(screen.getByText(/1.234/)).toBeTruthy();
    expect(screen.getByText(/Haftada iki gönderi/)).toBeTruthy();
    expect(screen.getByText(/Son güncelleme:/)).toBeTruthy();
  });

  it("veri yoksa boş durum gösterir", () => {
    simulasyon({ status: "empty", source: { issueId: null, issueTitle: null, documentKey: "sosyal-medya-durum" }, scannedIssueCount: 5 });
    render(<SosyalMedyaPage context={{} as never} />);

    expect(screen.getByText("Henüz sosyal medya verisi yok")).toBeTruthy();
  });

  it("doküman bulunamazsa yönlendirme gösterir", () => {
    simulasyon({ status: "not-found", source: { issueId: null, issueTitle: null, documentKey: "sosyal-medya-durum" }, scannedIssueCount: 5, reason: "Son 5 issue'da bulunamadı." });
    render(<SosyalMedyaPage context={{} as never} />);

    expect(screen.getByText("Durum verisi bulunamadı")).toBeTruthy();
    expect(screen.getAllByText(/Son 5 issue'da bulunamadı/).length).toBeGreaterThan(0);
  });

  it("geçersiz veride şema ipucu gösterir", () => {
    simulasyon({ status: "invalid", source: { issueId: "issue-1", issueTitle: null, documentKey: "sosyal-medya-durum" }, scannedIssueCount: 2, reason: "JSON.parse başarısız." });
    render(<SosyalMedyaPage context={{} as never} />);

    expect(screen.getByText("Durum verisi okunamadı")).toBeTruthy();
    expect(screen.getByText(/JSON.parse başarısız./)).toBeTruthy();
  });

  it("veri kaynağı hatasında hata mesajını gösterir", () => {
    simulasyon({ error: new Error("bağlantı kesildi") });
    render(<SosyalMedyaPage context={{} as never} />);

    expect(screen.getByText(/bağlantı kesildi/)).toBeTruthy();
  });
});
