# EVOHAUS AI — PAYLASILMIS BAGLAM

Bu dosya tum 14 agent tarafindan paylasilan ortak bilgi kaynağidir.
Agent-spesifik bilgiler SOUL.md'de, ortak bilgiler burada tutulur.

---

## 1. SIRKET KIMLIGI

- **Sirket**: EVOHAUS AI
- **Konum**: Mersin Teknopark / Tarsus OSB
- **Kurucu**: Nail Yakupoglu (teknik) + Onur (is gelistirme)
- **Company ID**: `e4f86ad5-bcdd-4ac9-9972-11ed5f6c7820`
- **Alan Adi**: evohaus.org (Cloudflare)
- **Paperclip**: http://localhost:3100 (Mac Mini) / https://control.evohaus.org (VPS)

---

## 2. URUN ENVANTERI

| # | Proje | Domain | Schema | Durum | Musteri |
|---|-------|--------|--------|-------|---------|
| 1 | Navico | navico.evohaus.org | navico | Aktif | Blue Eagle, TransAktas, Sokin |
| 2 | HukukBank | hukukbank.evohaus.org | hukukbank | Aktif | — |
| 3 | Emir | vepora.evohaus.org | emir | Aktif | — |
| 4 | MersinSteel | mersinsteel.evohaus.org | muhittin | Aktif | Muhittin Ozbas |
| 5 | KsAtlas | ksatlas.evohaus.org | ksatlas | Aktif | KS Atlas |
| 6 | CelalIsinlik | — | celalv3 | Bekleme | Celal Isinlik |
| 7 | EkstreAI | — | ekstrai | Aktif Gelistirme | — |
| 8 | PsikoRuya | — | psikoruya | Bekleme | — |

### Paperclip Proje Profilleri

Her urun Paperclip'te bir **project** olarak kayitlidir. Detayli profil bilgisi (musteri, deployment, tech stack, entegrasyonlar, scraper'lar) icin:

```
GET /api/projects/:id/profile
```

Pilot projeler: **MersinSteel** (slug: `mersin-steel`) ve **Navico** (slug: `navico`).

Profiller `project_profiles`, `project_integrations`, `project_scrapers` tablolarinda saklanir.

---

## 3. AKTIF MUSTERILER

| # | Musteri | Urun | Tier | Kanal |
|---|---------|------|------|-------|
| 1 | Muhittin Ozbas | MersinSteel | 1 | WhatsApp |
| 2 | KS Atlas | KsAtlas | 1 | WhatsApp |
| 3 | Celal Isinlik | CelalIsinlik | 2 | WhatsApp |
| 4 | Blue Eagle | Navico | 1 | WhatsApp |
| 5 | TransAktas | Navico | 1 | WhatsApp |
| 6 | Sokin Lojistik | Navico | 2 | WhatsApp |

---

## 4. TECH STACK

- **Frontend**: Next.js 16 + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui
- **Backend**: Python (FastAPI) + Node.js
- **Veritabani**: Self-hosted Supabase (PostgreSQL)
  - URL: https://supabase.evohaus.org
  - Studio: https://studio.supabase.evohaus.org
  - Port: 127.0.0.1:5433 (sadece localhost, VPS uzerinde)
- **Deploy**: Docker + Coolify + Traefik
- **CI/CD**: GitHub Actions + SSH deploy
- **Container**: Docker Compose
- **DNS**: Cloudflare

---

## 5. VPS ALTYAPI

- **IP**: 31.97.176.234
- **Spec**: 4 vCPU, 16GB RAM, 200GB Disk
- **SSH**: `ssh -i ~/.ssh/id_ed25519_deploy root@31.97.176.234`
- **OS**: Ubuntu

### Port Haritasi
| Servis | Port | Dizin |
|--------|------|-------|
| Navico Dashboard | 3003 | /opt/navico |
| Emir Frontend | 3000 | /opt/emir |
| Emir Backend | 8004 | /opt/emir |
| MersinSteel | 3007 | /opt/muhittin |
| KsAtlas | 3008 | /opt/ksatlas |
| Seyir Mobil API | 9530 | /opt/seyir |
| Arvento Scraper | 9526 | /root/arvento-scraper |
| Mobiliz Scraper | 8765 | /root/mobiz-scraper |
| SeyirMobil Scraper | 9530 | /root/seyir_mobil_scraper |
| SeyirLink Scraper | 8100 | /root/seyir_link_scraper |
| GPSBuddy Scraper | 8003 | /root/gpsbuddy-scraper |
| Oregon Scraper | 8200 | /root/oregon_scraper |
| Musait | 3005 | — |

### Dokunulmaz Servisler
- **Coolify** — Container yonetim platformu
- **Traefik** — Reverse proxy + otomatik SSL
- **n8n** — Workflow automation (nail.n8n.evohaus.org)

---

## 6. SUPABASE SCHEMA'LARI

| # | Schema | Proje | PostgREST |
|---|--------|-------|-----------|
| 1 | navico | Navico | ✓ |
| 2 | emir | Emir | ✓ |
| 3 | muhittin | MersinSteel | ✓ |
| 4 | ksatlas | KsAtlas | ✓ |
| 5 | hukukbank | HukukBank | ✓ |
| 6 | celalv3 | CelalIsinlik | ✓ |
| 7 | ekstrai | EkstreAI | ✓ |
| 8 | psikoruya | PsikoRuya | ✓ |
| 9 | evohaus | CRM | ✓ |

PostgREST erişim: `Accept-Profile: <schema>` + `Content-Profile: <schema>` headers

---

## 7. EVRENSEL GUVENLIK KURALLARI

1. **n8n, Coolify, Traefik'e ASLA dokunma** — altyapi servisleri Coolify yonetiyor
2. **Scraper'lari ASLA durdurma** — Navico Collector bagimli
3. **`docker compose down` ASLA** — tum servisleri oldurur
4. **Evolution API ASLA logout/disconnect** — e2e key sifirlanir
5. **Credential'lari ASLA SOUL.md/TOOLS.md'ye yazma** — .env kullan
6. **Guvenli guncelleme**: `docker compose up -d --build --no-deps <servis>`
7. **Port 18789'u ASLA internete acma** — OpenClaw gateway

---

## 8. ILETISIM PROTOKOLLERI

| Kanal | Kullanan | Amac |
|-------|---------|------|
| Paperclip (issue/comment) | Tum agent'lar | Asenkron is yonetimi |
| Telegram (@Evo1333_bot) | Agent → Nail/Onur | Acil eskalasyon |
| WhatsApp (Evolution API) | n8n → Musteri | Otomatik musteri iletisimi |
| Email (Gmail) | Email Yonetimi | Inbox triage |

---

## 9. ESKALASYON MATRISI

| Seviye | Aksiyon | Kanal |
|--------|---------|-------|
| INFO | Issue comment yaz | Paperclip |
| WARNING | Comment + ust yoneticiye bildir | Paperclip |
| CRITICAL | Telegram + WhatsApp (Nail) | Paperclip + Telegram |

### Eskalasyon Tetikleyicileri
- Scraper >60dk down → CRITICAL
- VPS CPU >95% → CRITICAL
- SSL <7 gun → CRITICAL
- P0 guvenlik acigi → CRITICAL
- Musteri sikayeti → WARNING
- Backup basarisiz → WARNING

---

## 10. ORGANIZASYON SEMASI

```
CEO (e2d75d5c) — Board'a raporlar
├── COO (b3450e90) — Operasyon
│   ├── Scraper Monitor (0b4e0995) — 15dk
│   ├── VPS Monitor (316d7d54) — 30dk
│   ├── Musteri Iletisim (652df935) — 1h
│   └── CRM Yonetimi (07234e13) — 6h
├── CTO (898e51ee) — Teknoloji
│   ├── Deploy Agent (e63b49e6) — Event
│   ├── Guvenlik Agent (d0d5f78d) — 24h
│   ├── Teknik Arastirma (422539e1) — 24h
│   └── Veritabani Yonetimi (d7325050) — 6h
└── CGO (90ab8038) — Buyume
    ├── Pazar Arastirma (0af6ab0b) — 12h
    ├── Satis Outreach (ac11c4c9) — 4h
    └── Email Yonetimi (c4ecf9bb) — 1h
```

### Agent ID Tam Referans
| Agent | Kisa ID | Tam UUID | Birim |
|-------|---------|----------|-------|
| CEO | e2d75d5c | e2d75d5c-...  | Board |
| COO | b3450e90 | b3450e90-5c0d-4f15-8a4d-bc55ecd543b5 | Ops |
| CTO | 898e51ee | 898e51ee-061d-4644-b44e-68b930323b81 | Tech |
| CGO | 90ab8038 | 90ab8038-faac-4e4e-afba-85ebf9b5d273 | Growth |
| Scraper Monitor | 0b4e0995 | 0b4e0995-2255-489b-ba68-9cf0c663be30 | Ops |
| Deploy Agent | e63b49e6 | e63b49e6-24bb-4549-9188-b2b97e9ab6bf | Tech |
| Guvenlik Agent | d0d5f78d | d0d5f78d-a940-429e-b52d-6716729bf0b9 | Tech |

| VPS Monitor | 316d7d54 | 316d7d54-... | Ops |
| Musteri Iletisim | 652df935 | 652df935-... | Ops |
| CRM Yonetimi | 07234e13 | 07234e13-... | Ops |
| Pazar Arastirma | 0af6ab0b | 0af6ab0b-... | Growth |
| Satis Outreach | ac11c4c9 | ac11c4c9-... | Growth |
| Email Yonetimi | c4ecf9bb | c4ecf9bb-... | Growth |
| Teknik Arastirma | 422539e1 | 422539e1-... | Tech |
| Veritabani Yonetimi | d7325050 | d7325050-... | Tech |

---

## 11. PAPERCLIP API REFERANSI

### Ortam Degiskenleri (Otomatik)
- `PAPERCLIP_API_URL` — http://localhost:3100
- `PAPERCLIP_API_KEY` — Bearer token
- `PAPERCLIP_COMPANY_ID` — e4f86ad5-bcdd-4ac9-9972-11ed5f6c7820
- `PAPERCLIP_AGENT_ID` — Senin ID'n
- `PAPERCLIP_RUN_ID` — Bu calismanin ID'si

### Auth Header
```
Authorization: Bearer $PAPERCLIP_API_KEY
Content-Type: application/json
X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
```

### Ana Endpoint'ler
| Method | Endpoint | Aciklama |
|--------|----------|----------|
| GET | /api/agents/me | Kendi bilgini al |
| GET | /api/companies/{id}/issues | Tum issue'lari listele |
| GET | /api/companies/{id}/agents | Tum agent'lari listele |
| POST | /api/companies/{id}/issues | Yeni issue olustur |
| POST | /api/issues/{id}/checkout | Issue uzerinde calis |
| POST | /api/issues/{id}/comments | Yorum yaz |
| PATCH | /api/issues/{id} | Issue guncelle |
| POST | /api/issues/{id}/documents | Dokuman olustur |

---

## 12. EVRENSEL IS KURALLARI

1. **CHECKOUT**: Issue ataninca CHECKOUT yap, yoksa baskasi alabilir
2. **COMMENT**: Her onemli milestone'da comment yaz
3. **BLOCKED**: status → `blocked`, comment ile sebebi acikla
4. **DONE**: Is bitince status → `done` veya `in_review`
5. **SAHIPLIK**: ASLA baska agent'in issue'suna checkout yapma
6. **SORU**: Anlamadigin issue varsa comment ile soru sor
7. **DOCUMENT**: Plan veya rapor icin document olustur

### Issue Status Degerleri
`backlog` → `todo` → `in_progress` → `in_review` → `done`
Alternatif: `blocked`, `cancelled`

### Priority Degerleri
`critical` > `high` > `medium` > `low`

---

## 13. BELGE FORMAT KONVANSIYONU

### Paperclip Belge Formatlari
- `RAPOR-GUNLUK-YYYY-MM-DD` (COO)
- `RAPOR-HAFTALIK-YYYY-WNN` (COO)
- `AUDIT-GUVENLIK-YYYY-MM-DD-<proje>` (Guvenlik)
- `RAPOR-PIPELINE-YYYY-WNN` (CGO)
- `DEPLOY-LOG-YYYY-MM-DD-<proje>` (Deploy)

### Comment Format Konvansiyonu
```
[STATUS:INFO|WARNING|CRITICAL] mesaj
[ESCALATION:NAIL|ONUR|<agent>] mesaj
[HANDOFF:<agent>] mesaj
[APPROVAL:NEEDED|GRANTED|REJECTED] mesaj
[VAULT:REF] vault-dosya-yolu
```

---

## 14. ILETISIM MATRISI (19 Akis)

```
Scraper Monitor → COO:    "Scraper X down" (15dk)
VPS Monitor → COO:        "VPS disk %82" (30dk)
Musteri Iletisim → COO:   "Musteri sikayet" (event)
Musteri Iletisim → CGO:   "Musteri yeni urun sordu" (event)
Veritabani Yon. → CTO:    "Backup basarisiz" (6sa)
Satis Outreach → CRM:     "Yeni lead" (4sa)
Satis Outreach → CGO:     "Sicak yanit" (event)
Email Yonetimi → CGO:     "Demo talebi email" (1sa)
Email Yonetimi → COO:     "Musteri sorun email" (1sa)
Email Yonetimi → Nail:    "Hukuk email — acil" (event→Telegram)
Teknik Arastirma → CTO:   "Gunluk tech digest" (24sa)
Guvenlik → CTO:           "Yeni vulnerability" (24sa)
Guvenlik → Nail:          "P0 guvenlik acigi" (event→Telegram)
Pazar Arastirma → CGO:    "Pazar firsati" (12sa)
Deploy & CI/CD → CTO:     "Deploy tamamlandi" (event)
COO → Nail:               "Gunluk ops ozeti" (09:00)
CGO → Nail:               "Haftalik pipeline" (Cuma)
CTO → Nail:               "Haftalik teknik" (Cuma)
CGO → Onur:               "Sicak lead" (event→Telegram)
```

---

## 15. GWS (GOOGLE WORKSPACE) ENTEGRASYONU

GWS CLI: `gws <servis> <resource> <method> [flags]`
Hesap: nailyakupoglu@gmail.com

### Agent-GWS Eslestirmesi
| Agent | GWS Servisleri | Kullanim |
|-------|---------------|----------|
| CEO | calendar, docs, gmail | Demo takvimi, strateji, kritik email |
| COO | drive, sheets | Muhittin Drive sync, operasyon tablolari |
| CTO | docs, drive | ADR dokumanlari, teknik spec |
| CGO | calendar, gmail, sheets | Demo planlama, outreach, pipeline |
| Musteri Iletisim | calendar | Musteri toplanti planlama |
| CRM Yonetimi | sheets, drive | Pipeline sheets |
| Pazar Arastirma | docs | Arastirma raporlari |
| Satis Outreach | gmail, calendar | Email gonderimi, demo |
| Email Yonetimi | gmail | Email triage |
| Teknik Arastirma | docs | Tech digest |
| Guvenlik | docs | Audit raporlari |

### Sik Kullanilan Komutlar
```bash
gws gmail messages list --query "is:unread" --max-results 20
gws gmail drafts create --to "x@y.com" --subject "..." --body "..."
gws calendar events create --summary "Demo" --start "..." --end "..."
gws drive files list --query "name contains '...'"
gws sheets values get <id> "Sheet1!A1:Z100"
gws docs create --title "ADR-XXX: ..."
```

---

## 16. VAULT YAZMA SAHIPLIGI

| Yazar | Vault Hedef | Tetikleyici |
|-------|-------------|-------------|
| COO | Ajanlar/_index.md | Durum degisikligi |
| COO | Iletisim/eskalasyonlar.md | Incident |
| CGO | Pipeline/aktif-leadler.md | Lead guncelleme |
| CGO | Pipeline/haftalik-rapor.md | Cuma rapor |
| CTO | Kararlar/ADR-*.md | Teknik karar |
| Scraper Monitor | Ajanlar/scraper-monitor.md | Anomali |
| VPS Monitor | Hafiza/altyapi.md | Altyapi degisikligi |
| CRM Yonetimi | Sirket/musteriler.md | CRM guncelleme |
| Pazar Arastirma | Sirket/rakipler.md | Istihbarat raporu |

## 16. HAFIZA MIMARISI

```
              ┌───────────────────┐
              │  Obsidian Vault   │ ← Tek Kaynak
              └────────┬──────────┘
                       │
         ┌─────────────┼─────────────┐
    Claude Code    Paperclip     OpenClaw
```

- **Vault**: ~/Documents/EvoHaus-Vault/ — kaynak
- **Paperclip**: Issue/comment — aktif is
- **OpenClaw**: workspace-*/MEMORY.md — agent-lokal
