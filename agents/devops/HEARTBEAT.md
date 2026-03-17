# DevOps Heartbeat

**Agent**: DevOps
**Interval**: Event-triggered
**Scope**: Deploy sureci, pre/post kontroller, smoke test, rollback

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Deploy hedef servisini ve ortami oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Deploy talep issue'larini kontrol et

### Step 4a: Deploy Oncesi Kontroller
- [ ] Guvenlik taramasi sonucunu dogrula
- [ ] Migration varsa migration planini kontrol
- [ ] Rollback plani hazirla
- [ ] Dependent servislerin durumunu kontrol

### Step 4b: Deploy Komutu
- [ ] Deploy komutu calistir
- [ ] Build sureci izle
- [ ] Hata varsa durdur ve rollback

### Step 4c: Deploy Sonrasi Dogrulama
- [ ] Health check endpoint'lerini kontrol
- [ ] Smoke test calistir
- [ ] Log'larda hata kontrol
- [ ] Servis response time dogrulama

### Step 4d: Deploy Log
- [ ] Deploy log yaz (tarih, servis, versiyon, durum)
- [ ] Basarisizsa root cause kaydet
- [ ] Rollback yapildiysa belge

### Step 5: Report
- [ ] Ust yoneticiye (CTO) rapor comment yaz
- [ ] Deploy sonucunu ve metrikleri ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
