# Tech Research Heartbeat

**Agent**: Tech Research
**Interval**: 24 saat
**Scope**: Teknoloji taramasi, guvenlik audit, AI model takibi, tech digest

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Takip edilen teknoloji stack'ini oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Tech Blog ve Changelog Taramasi
- [ ] Next.js, React, Supabase changelog kontrol
- [ ] Docker, Node.js guncelleme duyuruları
- [ ] Kullanilan kutuphanelerin major release kontrol

### Step 4b: Guvenlik Audit
- [ ] `npm audit` calistir (tum projeler icin)
- [ ] Docker CVE kontrol
- [ ] Bilinen zafiyet veritabanlarini tara

### Step 4c: AI Model Takibi
- [ ] AI model fiyat degisiklikleri kontrol
- [ ] Performans benchmark guncellemeleri
- [ ] Yeni model duyuruları ve karsilastirma

### Step 4d: Tech Digest Raporu
- [ ] Bulgulari tech digest formatinda yaz
- [ ] Oncelik: CRITICAL / HIGH / MEDIUM / LOW
- [ ] Stack'e etkisi: IMMEDIATE / PLANNED / WATCH

### Step 5: Report
- [ ] Ust yoneticiye (CTO) rapor comment yaz
- [ ] Onemli bulgulari ve onerileri ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
