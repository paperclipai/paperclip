# Scraper Ops Heartbeat

**Agent**: Scraper Ops
**Interval**: 15 dakika
**Scope**: 7 scraper saglik kontrolu, auto-remediation, eskalasyon

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Scraper listesini ve beklenen durumlari oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Scraper Health Check
- [ ] SSH ile VPS'e baglan
- [ ] Arvento (port 9526) kontrol
- [ ] Mobiliz (port 8765) kontrol
- [ ] Seyir Mobil (port 9530) kontrol
- [ ] Seyir Link (port 8100) kontrol
- [ ] GPS Buddy (port 8003) kontrol
- [ ] Oregon (port 8200) kontrol
- [ ] GZC24 kontrol

### Step 4b: Container ve Data Kontrolu
- [ ] Container status kontrol (`docker ps`)
- [ ] Son data timestamp kontrol (her scraper icin)
- [ ] Stale data tespit (beklenen araligin disinda)

### Step 4c: Auto-Remediation
- [ ] Exited container tespit et
- [ ] Otomatik restart uygula (max 2 deneme)
- [ ] Restart sonrasi health check dogrula

### Step 4d: Eskalasyon
- [ ] CRITICAL durum varsa COO'ya eskalasyon issue olustur
- [ ] 2x restart basarisiz → manuel mudahale talebi

### Step 5: Report
- [ ] Ust yoneticiye (COO) rapor comment yaz
- [ ] Scraper durum ozetini paylas

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
