# Email Manager Heartbeat

**Agent**: Email Manager
**Interval**: 1 saat
**Scope**: Gmail inbox yonetimi, kategorizasyon, taslak yanit, eskalasyon

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Email kategori kurallarini oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Gmail Inbox Tarama
- [ ] Gmail inbox tara (`gws gmail messages list --query "is:unread"`)
- [ ] Yeni emailleri listele
- [ ] Gonderici ve konu bilgilerini oku

### Step 4b: Kategorizasyon
- [ ] CUSTOMER → P0 (acil)
- [ ] SALES → P1
- [ ] PARTNER → P1
- [ ] TEKNOPARK → P1
- [ ] LEGAL → P0 (acil)
- [ ] SPAM → Atla

### Step 4c: Taslak Yanit Hazirlama
- [ ] Oncelikli emaillere taslak yanit hazirla
- [ ] Onay gerektirenleri isaretle
- [ ] Otomatik gonderilebilecekleri belirle

### Step 4d: Eskalasyon
- [ ] LEGAL → Nail'e Telegram bildirim
- [ ] SALES → CRM'e kayit olustur
- [ ] CUSTOMER P0 → COO'ya bildir

### Step 5: Report
- [ ] Ust yoneticiye (CGO) rapor comment yaz
- [ ] Email trafigini ve aksiyonlari ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
