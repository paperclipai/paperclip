# Fonksiyon Sözleşmeleri

Bu doküman yalnızca davranışı tanımlar. Ürün amacı, müşteri bilgisi ve gerçek veri örneği içermez. Tüm örnek veriler uydurmadır.

## dokumanMetnindenJsonAyikla(text)

- Girdi: string. UTF-8 metin; uzunluk sınırı yok.
- Çıktı: `{ ok: true, value: unknown }` ya da `{ ok: false, hata: string }`. Başarılı olduğunda value ayrıştırılmış JSON değeridir.
- Davranış: Önce gövdenin tamamını JSON.parse ile dener. Başarısızsa ilk markdown kod bloğunu (```json ya da ```) dener. İkisi de başarısızsa hata döndürür.
- Hata durumları: boş metin, ayrıştırılabilir JSON bulunamaması. Hata mesajı teknikseldir; veri içeriği örnekle dönmez.
- Yan etkiler: yok.

## parseSosyalMedyaVerisi(raw)

- Girdi: any. Ayrıştırılmış JSON değeri. Kök, opsiyonel updatedAt (string) ve opsiyonel accounts (dizi) alanlı obje beklenir.
- Çıktı:
  - Başarı: `{ ok: true, veri, uyarilar }`. veri alanları: updatedAt string ya da null; accounts dizisi. Her hesap: platform string (geçersiz değer "(bilinmeyen platform)" olur), handle ve url string ya da null, followers ve followersDelta30d ve engagementRate number ya da null (yalnızca sonlu sayı kabul edilir), recentPosts dizisi (her öğe title, url, publishedAt string ya da null), recommendations string dizisi.
  - Hata: `{ ok: false, hata }`. Yalnızca kök bir obje olmadığında (dize, dizi, sayı ya da null) döndürülür.
- Davranış: Geçersiz ya da eksik iç alanlar null değerine düşer ve uyarilar dizisine mesaj eklenir. Obje olmayan dizi öğeleri atlanır. Boşluk içi dize değerleri trim edilir.
- Yan etkiler: yok.

## bosVeri()

- Çıktı: sabit `{ updatedAt: null, accounts: [] }`.
- Yan etkiler: yok.

## panelAyariniCoz(ctx, companyId?)

- Girdi: ctx bir SDK PluginContext. companyId string ya da undefined olabilir.
- Çıktı: `{ issueId: string|null, documentKey: string, scanLimit: number }`. Boş issueId null olur. Boş documentKey "sosyal-medya-durum" olur. scanLimit 1 ile 100 arasında tamsayıya kilitlenir; dizgesel sayı girdisi de kabul edilir.
- Hata durumları: ctx.config.get istisna attığında varsayılan ayarlarla sonuç döndürülür; hata yutulur.
- Yan etkiler: yalnızca host üzerinden config okuma.

## sirketiCoz(ctx, companyId?)

- Girdi: companyId string ya da undefined.
- Çıktı: string ya da null. Girdi doluysa trim edilmiş değer. Değilse ctx.companies.list çağrısıyla ilk şirketin id'si. Hiç şirket yoksa null.
- Hata durumları: companies.list izin hatası SDK tarafından CAPABILITY_DENIED istisnası olarak iletilir; bu katman dönüştürmez.
- Yan etkiler: yalnızca host RPC.

## durumSnapshotGetir(ctx, companyId?)

- Çıktı: SosyalMedyaSnapshot birleşik tipi. Durumlar:
  - ok: doküman bulundu ve ayrıştırma başarılı. data, uyarilar, source (issueId, issueTitle, documentKey) ve scannedIssueCount dolu.
  - empty: doküman bulundu ama updatedAt boş ve accounts boş.
  - not-found: doküman hiçbir aday issue'da yok ya da ayarlanan issue bulunamadı. reason ve scannedIssueCount dolu.
  - invalid: doküman gövdesi JSON ya da şema olarak okunamadı. reason teknikseldir.
  - no-company: şirket çözülemedi.
- Davranış: Ayarlarda issueId doluysa yalnızca o issue kontrol edilir. Boşsa en güncel scanLimit issue taranır; ilk eşleşmede erken dönüş yapılır.
- Hata durumları: ctx.issues.documents ve ctx.issues istisnaları bu katmandan aynen yükselir. Worker kayıt katmanı istisnayı yakalar, status "invalid" ve reason ile döndürür ve ctx.logger.error ile kaydeder.
- Yan etkiler: yalnızca host RPC. Zaman aşımı, yeniden deneme veya önbellekleme davranışı bu katmanda yoktur.

## Worker veri işleyicileri

- "sosyal-medya-durum" işleyicisi: girdi `{ companyId?: string }`, çıktı SosyalMedyaSnapshot. İstisnaları yakalayarak status "invalid" ve reason ile döndürür; ctx.logger.error ile kaydeder.
- "plugin-config" işleyicisi: girdi `{ companyId?: string }`, çıktı panelAyariniCoz sonuç bloğu.
- Yan etkiler: kalıcı veri değişikliği yok; logger mesajı yazabilir.

## UI bileşenleri

- SosyalMedyaPage(props): PluginPageProps alır. useHostContext ve usePluginData kullanır. Yükleniyor, hata, empty, not-found, invalid ve ok durumlarına göre bilgi kartı, boş durum veya hesap kartları gösterir. Dış bağlantılar standart a ögesidir; target "_blank", rel "noreferrer noopener" olarak ayarlanır.
- SosyalMedyaSidebar(props): PluginSidebarProps alır. Host yönlendirme sözleşmesi üzerinden linkProps("/sosyal-medya") bağlantısı döndürür; aktifken aria-current "page" olur.
- Yan etkiler: yok. Veri yenileme davranışını usePluginData belirler.

## Biçimlendirme yardımcıları (src/ui/format.ts)

- formatSayi(value): null, undefined ya da NaN için "—". Diğer durumda Intl.NumberFormat("tr-TR") çıktısı.
- formatDegisim(value): null için boş metin; pozitif için "+N"; negatif için "−N" (U+2212); sıfır için "0".
- degisimTonu(value): "positive", "negative", "neutral" ya da "none".
- formatEtkilesimOrani(value): null için "—". 0 dan büyük ve 1 e eşit ya da küçük değer yüzde sayısına çevrilir. Üstü ham yüzde kabul edilir. Çıktı yüzde öneklidir.
- formatTarih(value): null ya da boş için "—". Geçersiz dize ham metin olarak döner. Başarıda tr-TR uzun tarih çıktısı.
- Tümü yan etkisiz ve deterministiktir.

## Test sözleşmesi

- Test dosyaları: tests/parse-durum.spec.ts, tests/durum-service.spec.ts, tests/manifest.spec.ts, tests/format.spec.ts, tests/ui-page.spec.tsx.
- UI testleri SDK'nın UI modülünü mock eder. Ağ etkileşimi yoktur.
- Tüm test verileri uydurmadır.
