# CEO Heartbeat

**Agent**: CEO
**Interval**: 2 saat
**Scope**: Tum organizasyon gozetimi, karar alma, delegasyon

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Guncel organizasyon durumunu kavra

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Issue ve Rapor Kontrolu
- [ ] Tum issue'lari oku
- [ ] COO raporlarini kontrol et
- [ ] CTO raporlarini kontrol et
- [ ] CGO raporlarini kontrol et

### Step 4b: Karar Agaci
- [ ] CRITICAL durum varsa → Telegram ile Nail'e bildir
- [ ] Agent/takim catismasi varsa → Resolution karari ver
- [ ] Butce asimi varsa → Ilgili islemi pause et

### Step 4c: Delegasyon
- [ ] Eksik gorev varsa yeni issue olustur
- [ ] Dogru agent'a ata ve delege et
- [ ] Deadline ve oncelik belirle

### Step 5: Report
- [ ] Ust yoneticiye (Nail) rapor comment yaz
- [ ] Onemli kararlari ve aksiyonlari ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol (>48 saat aktivitesiz)
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
