import {
  useHostContext,
  useHostNavigation,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import type { ReactNode } from "react";
import type { SosyalMedyaHesap, SosyalMedyaVeri } from "../parse-durum.js";
import type { PanelConfig, SosyalMedyaSnapshot } from "../types.js";
import { PAGE_ROUTE } from "../constants.js";
import {
  degisimTonu,
  formatDegisim,
  formatEtkilesimOrani,
  formatSayi,
  formatTarih,
} from "./format.js";

const renkler = {
  metin: "#1f2328",
  soluk: "#656d77",
  kenarlik: "var(--border, #d0d7de)",
  vurgu: "#0969da",
  zarf: "var(--bg-secondary, #f6f8fa)",
  positif: "#1a7f37",
  negatif: "#cf222e",
};

function YatayBilgi({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px solid ${renkler.kenarlik}`,
        background: renkler.zarf,
        color: renkler.metin,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

function BosDurum() {
  return (
    <div style={{ padding: 24, textAlign: "center", color: renkler.soluk, fontSize: 14 }}>
      <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
      <strong style={{ display: "block", color: renkler.metin, marginBottom: 4 }}>Henüz sosyal medya verisi yok</strong>
      <div>
        İçerik &amp; Sosyal Medya ajanı <code>sosyal-medya-durum</code> dokümanını güncellediğinde bu sayfa otomatik
        dolar.
      </div>
    </div>
  );
}

function HesapKarti({ hesap }: { hesap: SosyalMedyaHesap }) {
  const ton = degisimTonu(hesap.followersDelta30d);
  const gonderiler = hesap.recentPosts ?? [];
  const oneriler = hesap.recommendations ?? [];

  return (
    <div
      style={{
        border: `1px solid ${renkler.kenarlik}`,
        borderRadius: 8,
        padding: 14,
        display: "grid",
        gap: 10,
        minWidth: 260,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>{hesap.platform}</strong>
        {hesap.handle ? (
          hesap.url ? (
            <a href={hesap.url} target="_blank" rel="noreferrer noopener" style={{ color: renkler.vurgu, fontSize: 13 }}>
              {hesap.handle}
            </a>
          ) : (
            <span style={{ color: renkler.soluk, fontSize: 13 }}>{hesap.handle}</span>
          )
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
        <span>
          Takipçi: <strong>{formatSayi(hesap.followers)}</strong>
        </span>
        {hesap.followersDelta30d !== null && hesap.followersDelta30d !== undefined ? (
          <span
            style={{
              color: ton === "positive" ? renkler.positif : ton === "negative" ? renkler.negatif : renkler.soluk,
              fontWeight: 600,
            }}
          >
            30 gün: {formatDegisim(hesap.followersDelta30d)}
          </span>
        ) : null}
        <span>
          Etkileşim: <strong>{formatEtkilesimOrani(hesap.engagementRate)}</strong>
        </span>
      </div>

      {gonderiler.length > 0 ? (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: renkler.soluk, marginBottom: 4 }}>Son gönderiler</div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }}>
            {gonderiler.slice(0, 3).map((gonderi, index) => (
              <li key={index} style={{ marginBottom: 2 }}>
                {gonderi.url ? (
                  <a href={gonderi.url} target="_blank" rel="noreferrer noopener" style={{ color: renkler.vurgu }}>
                    {gonderi.title ?? gonderi.url}
                  </a>
                ) : (
                  <span>{gonderi.title ?? "(gönderi)"}</span>
                )}
                {gonderi.publishedAt ? <span style={{ color: renkler.soluk }}> · {gonderi.publishedAt}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {oneriler.length > 0 ? (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: renkler.soluk, marginBottom: 4 }}>Öneriler</div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }}>
            {oneriler.map((oneri, index) => (
              <li key={index} style={{ marginBottom: 2 }}>
                {oneri}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function VeriBolumu({ veri, uyarilar }: { veri: SosyalMedyaVeri; uyarilar: string[] }) {
  if (veri.accounts.length === 0) return <BosDurum />;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {uyarilar.length > 0 ? (
        <div style={{ fontSize: 12, color: renkler.soluk }}>
          Ayrıştırma uyarıları ({uyarilar.length}): {uyarilar[0]} {uyarilar.length > 1 ? "… (diğer alanlar yok sayıldı)" : ""}
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {veri.accounts.map((hesap, index) => (
          <HesapKarti key={`${hesap.platform}-${index}`} hesap={hesap} />
        ))}
      </div>
    </div>
  );
}

function SnapshotGorunumu({ snapshot }: { snapshot: SosyalMedyaSnapshot }) {
  switch (snapshot.status) {
    case "ok":
      return <VeriBolumu veri={snapshot.data} uyarilar={snapshot.uyarilar} />;
    case "empty":
      return <BosDurum />;
    case "not-found":
      return (
        <YatayBilgi>
          <strong style={{ display: "block", marginBottom: 4 }}>Durum verisi bulunamadı</strong>
          {snapshot.reason} Eklenti ayarlarında doğru issue ID'sini seçerek ya da İçerik &amp; Sosyal Medya ajanının{" "}
          <code>{snapshot.source?.documentKey ?? "sosyal-medya-durum"}</code> dokümanını yazmasını bekleyerek bu sayfayı
          doldurabilirsin.
        </YatayBilgi>
      );
    case "invalid":
      return (
        <YatayBilgi>
          <strong style={{ display: "block", marginBottom: 4 }}>Durum verisi okunamadı</strong>
          {snapshot.reason} Dokümanı şu şemada tut:{" "}
          <code>{`{updatedAt, accounts:[{platform, handle, url, followers, followersDelta30d, engagementRate, recentPosts, recommendations}]}`}</code>
        </YatayBilgi>
      );
    case "no-company":
      return <YatayBilgi>Aktif şirket bulunamadı; durumu göstermek için bir şirkete bağlanın.</YatayBilgi>;
    default:
      return <BosDurum />;
  }
}

export function SosyalMedyaPage(_props: PluginPageProps) {
  const { companyId } = useHostContext();
  const durum = usePluginData<SosyalMedyaSnapshot>("sosyal-medya-durum", companyId ? { companyId } : {});
  const config = usePluginData<PanelConfig & { documentKeyVarsayilanmi?: boolean }>("plugin-config", companyId ? { companyId } : {});

  return (
    <div style={{ maxWidth: 960, padding: 20, display: "grid", gap: 16, color: renkler.metin }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Sosyal Medya</h1>
        {durum.data?.status === "ok" ? (
          <span style={{ fontSize: 13, color: renkler.soluk }}>Son güncelleme: {formatTarih(durum.data.data.updatedAt)}</span>
        ) : null}
      </header>

      <p style={{ fontSize: 13, color: renkler.soluk, margin: 0 }}>
        Hesap durumu ve öneriler, İçerik &amp; Sosyal Medya ajanının{" "}
        <code>{config.data?.documentKey ?? "sosyal-medya-durum"}</code> dokümanından okunur.
        {config.data?.issueId ? null : " Dokümanı tutan issue belli değilse eklenti ayarlarından issue ID'sini belirleyebilirsin."}
      </p>

      {durum.loading ? <YatayBilgi>Yükleniyor…</YatayBilgi> : null}
      {durum.error ? (
        <YatayBilgi>
          <strong>Eklenti veri kaynağı hatası:</strong> {durum.error.message}
        </YatayBilgi>
      ) : null}
      {!durum.loading && !durum.error && durum.data ? <SnapshotGorunumu snapshot={durum.data} /> : null}
    </div>
  );
}

export function SosyalMedyaSidebar(_props: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const href = hostNavigation.resolveHref(`/${PAGE_ROUTE}`);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps(`/${PAGE_ROUTE}`)}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 10c0-3 1.5-6 5-6s5 3 5 6-1 8-5 8-5-5-5-8Z" />
        <circle cx="12" cy="9" r="2.4" />
        <path d="M4 18c.6-2.6 2.4-4.4 8-4.4s7.4 1.8 8 4.4" />
      </svg>
      <span className="flex-1 truncate">Sosyal Medya</span>
    </a>
  );
}
