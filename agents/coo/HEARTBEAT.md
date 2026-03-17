# COO Heartbeat

**Agent**: COO
**Interval**: 2 saat
**Scope**: Operasyonel yonetim, alt-agent koordinasyonu, VPS saglik

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Guncel operasyonel durumu kavra

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Alt-Agent Raporlari
- [ ] Scraper Monitor raporunu oku
- [ ] VPS Monitor raporunu oku
- [ ] Musteri Iletisim raporunu oku
- [ ] CRM raporunu oku

### Step 4b: VPS Saglik Kontrol
- [ ] SSH ile VPS'e baglan
- [ ] CPU / RAM / Disk metrikleri oku
- [ ] Servis durumlari kontrol et

### Step 4c: n8n Workflow Kontrolu
- [ ] n8n workflow execution log kontrol
- [ ] Basarisiz execution varsa tespit et
- [ ] Tekrarlayan hatalari isaretle

### Step 4d: Incident Yonetimi
- [ ] Incident varsa root cause analiz yap
- [ ] Postmortem raporu olustur
- [ ] Aksiyonlari ilgili agent'lara ata

### Step 5: Report
- [ ] Ust yoneticiye (CEO) rapor comment yaz
- [ ] Operasyonel durumu ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
