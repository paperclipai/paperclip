# DB Manager Heartbeat

**Agent**: DB Manager
**Interval**: 6 saat
**Scope**: Backup kontrolu, DB boyut izleme, performans analizi, bakim

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] DB schema listesini ve threshold degerlerini oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Backup Durumu
- [ ] Backup durumu kontrol (`ls /root/backups/supabase/`)
- [ ] Son basarili backup tarihini dogrula
- [ ] Backup dosya boyutlarini kontrol

### Step 4b: DB Boyut Kontrolu
- [ ] `pg_database_size` ile DB boyutunu kontrol
- [ ] Schema bazli boyut dagilimi
- [ ] Buyume trendi degerlendirme

### Step 4c: Yavas Query Tespiti
- [ ] `pg_stat_statements` ile yavas query'leri tespit
- [ ] En yavas 10 query'yi listele
- [ ] Optimizasyon onerisi hazirla

### Step 4d: Bakim Kontrolleri
- [ ] Dead tuple sayisi kontrol (VACUUM gerekliligi)
- [ ] Aktif baglanti sayisi kontrol
- [ ] Connection pool durumu degerlendirme

### Step 5: Report
- [ ] Ust yoneticiye (CTO) rapor comment yaz
- [ ] DB saglik durumunu ve metrikleri ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
