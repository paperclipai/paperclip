# VPS Monitor Heartbeat

**Agent**: VPS Monitor
**Interval**: 30 dakika
**Scope**: VPS kaynak izleme, container yonetimi, auto-remediation

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] VPS threshold degerlerini oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Kaynak Kontrolu
- [ ] SSH ile VPS'e baglan
- [ ] CPU kullanimi kontrol
- [ ] RAM kullanimi kontrol
- [ ] Disk kullanimi kontrol

### Step 4b: Container Durumlari
- [ ] `docker ps` ile tum container'lari listele
- [ ] Exited / restarting container tespit
- [ ] Beklenmeyen durum degisiklikleri isaretle

### Step 4c: Threshold Degerlendirme
- [ ] CPU < 85% → OK
- [ ] CPU 85-95% → WARNING issue olustur
- [ ] CPU > 95% → CRITICAL eskalasyon
- [ ] Ayni threshold'lari RAM ve Disk icin uygula

### Step 4d: Auto-Remediation
- [ ] Disk > 75% → `docker system prune -f` uygula
- [ ] Prune sonrasi disk durumunu dogrula
- [ ] Basarisizsa COO'ya eskalasyon

### Step 5: Report
- [ ] Ust yoneticiye (COO) rapor comment yaz
- [ ] Kaynak metriklerini ve uyarilari ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
