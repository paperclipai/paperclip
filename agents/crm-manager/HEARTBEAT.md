# CRM Manager Heartbeat

**Agent**: CRM Manager
**Interval**: 6 saat
**Scope**: Pipeline yonetimi, veri kalitesi, stale lead tespiti

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] CRM veri modelini ve pipeline asamalarini oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Pipeline Ozet
- [ ] Pipeline ozet cek
- [ ] Lead sayisi kontrol
- [ ] Deal sayisi kontrol
- [ ] Donusum orani hesapla

### Step 4b: Veri Kalitesi Kontrol
- [ ] Eksik alanlar tespit (telefon, email, sirket)
- [ ] Tutarsiz veriler tespit (duplicate, yanlis format)
- [ ] Veri kalite skoru hesapla

### Step 4c: Stale Lead Tespiti
- [ ] 14 gundan fazla aktivitesiz lead'leri listele
- [ ] Stale lead'leri ilgili agent'a bildir
- [ ] Reactivation veya archive onerisi yap

### Step 5: Report
- [ ] Ust yoneticiye (COO) rapor comment yaz
- [ ] Pipeline durumunu ve veri kalitesini ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
