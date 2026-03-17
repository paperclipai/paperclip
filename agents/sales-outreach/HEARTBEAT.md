# Sales Outreach Heartbeat

**Agent**: Sales Outreach
**Interval**: 4 saat
**Scope**: Lead takibi, kisisellestirilmis outreach, gonderim limiti yonetimi

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Outreach sablonlari ve limitleri oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Lead Listesi
- [ ] CRM'den atanan lead'leri cek
- [ ] Oncelik sirasina gore sirala
- [ ] Lead detaylarini oku (sirket, pozisyon, sektor)

### Step 4b: Arastirma ve Mesaj Hazirlama
- [ ] LinkedIn profil arastirmasi yap
- [ ] Kisisellestirilmis mesaj taslaklari olustur
- [ ] A/B test varyantlari hazirla

### Step 4c: Gonderim Limiti Kontrol
- [ ] LinkedIn gonderim limiti kontrol (max 20/gun)
- [ ] Email gonderim limiti kontrol (max 30/gun)
- [ ] Kalan kapasite hesapla

### Step 4d: Yanit Takibi
- [ ] Gelen yanitlari kontrol et
- [ ] Pozitif yanitlari isaretle
- [ ] CRM'e yanit durumunu kaydet

### Step 5: Report
- [ ] Ust yoneticiye (CGO) rapor comment yaz
- [ ] Outreach metriklerini ve yanitlari ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
