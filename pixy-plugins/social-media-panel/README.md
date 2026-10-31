# Sosyal Medya Panel (Paperclip eklentisi)

Paperclip'in sol menüsüne **Sosyal Medya** sekmesi ekleyen eklenti. Panelde
hesap kartları (takipçi sayısı ve 30 günlük değişim), son gönderiler, etkileşim
oranı, İçerik & Sosyal Medya ajanının önerileri ve son güncelleme zamanı görünür.

Eklenti harici servise istek atmaz, gizli anahtar ya da token tutmaz. Tüm veriyi
Paperclip'te `sosyal-medya-durum` anahtarlı issue dokümanından okur.

## Veri sözleşmesi

İçerik & Sosyal Medya ajanı şu şemadaki JSON'u, durum görevinin
`sosyal-medya-durum` dokümanına JSON bloğu olarak yazar:

```json
{
  "updatedAt": "2026-10-30T09:00:00Z",
  "accounts": [
    {
      "platform": "instagram",
      "handle": "@pixydigital",
      "url": "https://instagram.com/pixydigital",
      "followers": 1234,
      "followersDelta30d": 42,
      "engagementRate": 0.05,
      "recentPosts": [{ "title": "Kampanya", "url": "https://instagram.com/p/1", "publishedAt": "2026-10-20" }],
      "recommendations": ["Haftada iki gönderi"]
    }
  ]
}
```

Doküman gövdesi düz JSON ya da markdown içinde ```json kod bloğu olabilir.

## Kurulum (yalnızca kullanıcı; instance admin yetkisi gerekir)

```bash
# 1) Paperclip'i çalışır durumda başlatın (varsayılan: http://127.0.0.1:3100)
pnpm paperclipai run

# 2) Dep kökünde bağımlılıkları kurun ve bir terminalde izleme derlemesini başlatın
pnpm install
pnpm --filter @pixy/social-media-panel dev

# 3) Kurulumu kullanıcı yapar (instance admin)
paperclipai plugin install <dep-kökü>/pixy-plugins/social-media-panel

# 4) Kaydı doğrulayın
paperclipai plugin list
paperclipai plugin inspect pixy.social-media-panel
```

Kurulumdan sonra:

1. Paperclip panelinde **Settings → Plugins → Sosyal Medya** sayfasını açın.
2. "Sosyal Medya Durum Issue ID" alanına, İçerik ajanının `sosyal-medya-durum`
   dokümanını tuttuğu görevin issue ID'sini (UUID) yazın. Boş bırakırsanız
   eklenti en güncel 30 görev içinde dokümanı arar.
3. Sol menüdeki **Sosyal Medya** sekmesi eklenti sayfasına (`/sosyal-medya`) gider.

Üretim için paketin npm'e basılması gereklidir; bu PR kapsamında kurulum
yapılmaz.

## Geliştirme komutları

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Tasarım notları

- Panel UI'ı kendi kendine yeterlidir; host UI bileşen kitine bağımlı değildir.
- Beyan edilen yetenekler yalnızca okuma amaçlıdır: `companies.read`,
  `issues.read`, `issue.documents.read`, `ui.page.register`, `ui.sidebar.register`.
- `http.outbound`, `secrets.*`, `env.*` yetenekleri kasıtlı olarak beyan edilmez.
