# Market Research Heartbeat

**Agent**: Market Research
**Interval**: 12 saat
**Scope**: Sektor tarama, rakip analizi, intelligence brief

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Takip edilen sektorleri ve rakipleri oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Sektor Taramasi
- [ ] Lojistik/filo yonetimi sektoru tara (Google News / X / LinkedIn)
- [ ] Gumruk / dis ticaret sektoru tara
- [ ] Hukuk teknolojisi sektoru tara
- [ ] Celik / metal sektoru tara
- [ ] SaaS / B2B teknoloji sektoru tara

### Step 4b: Rakip Analizi
- [ ] Rakip web siteleri degisiklik kontrol
- [ ] Yeni urun/ozellik duyuruları tespit
- [ ] Fiyat degisiklikleri takip

### Step 4c: Intelligence Brief
- [ ] Bulgulari kategorize et: OPPORTUNITY / THREAT / INFO
- [ ] Oncelik belirle: HIGH / MEDIUM / LOW
- [ ] Yapilandirilmis brief yaz

### Step 5: Report
- [ ] Ust yoneticiye (CGO) rapor comment yaz
- [ ] Onemli bulgulari ve firsatlari ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
