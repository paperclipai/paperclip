# CTO Heartbeat

**Agent**: CTO
**Interval**: 3 saat
**Scope**: Teknik liderlik, guvenlik, deploy, backup, arastirma

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Guncel teknik durumu kavra

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Guvenlik Raporu
- [ ] Guvenlik agent raporunu oku
- [ ] CRITICAL bulgular varsa aksiyon planla
- [ ] CVE / dependency alert'leri degerlendirme

### Step 4b: Deploy Log Kontrolu
- [ ] Deploy agent log'lari kontrol et
- [ ] Son deploy'larin basarili olup olmadigini dogrula
- [ ] Rollback gerektiren durumlari tespit et

### Step 4c: Backup Durumu
- [ ] DB agent raporundan backup durumunu kontrol et
- [ ] Son basarili backup tarihini dogrula
- [ ] Backup boyutu ve butunlugunu kontrol et

### Step 4d: Tech Digest
- [ ] Teknik Arastirma agent raporunu oku
- [ ] Yeni teknoloji / tool degerlendirmesi
- [ ] Stack'e etki edebilecek degisiklikleri isaretle

### Step 4e: Audit Skor Degerlendirmesi
- [ ] Genel teknik audit skorunu hesapla
- [ ] Iyilestirme gereken alanlari belirle
- [ ] Oncelikli teknik borc listesini guncelle

### Step 5: Report
- [ ] Ust yoneticiye (CEO) rapor comment yaz
- [ ] Teknik durumu ve riskleri ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
