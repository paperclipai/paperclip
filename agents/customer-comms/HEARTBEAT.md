# Customer Comms Heartbeat

**Agent**: Customer Comms
**Interval**: 1 saat
**Scope**: WhatsApp/Telegram iletisim, SLA takibi, yanit hazirlama

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] SLA kurallarini ve iletisim kanallarini oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: WhatsApp Kontrolu
- [ ] WhatsApp inbox kontrol (Evolution API)
- [ ] Yeni mesajlari listele
- [ ] Musteri bazli gruplama yap

### Step 4b: Telegram Kontrolu
- [ ] Telegram bot mesajlari kontrol
- [ ] Yeni mesajlari listele
- [ ] Oncelik belirle

### Step 4c: SLA Takibi
- [ ] SLA asimi tespit et
- [ ] Yanitlanmamis mesajlarin bekleme suresini hesapla
- [ ] SLA ihlali varsa eskalasyon isaretle

### Step 4d: Yanit Hazirlama
- [ ] Taslak yanitlar hazirla
- [ ] Onay gerektiren yanitlari isaretle
- [ ] Otomatik gonderilebilecekleri belirle

### Step 5: Report
- [ ] Ust yoneticiye (COO) rapor comment yaz
- [ ] Iletisim durumunu ve SLA metriklerini ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
