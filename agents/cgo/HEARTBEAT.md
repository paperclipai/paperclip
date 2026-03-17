# CGO Heartbeat

**Agent**: CGO
**Interval**: 4 saat
**Scope**: Buyume stratejisi, pipeline yonetimi, segment analizi

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Guncel buyume metriklerini kavra

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Alt-Agent Raporlari
- [ ] Pazar Arastirma agent raporunu oku
- [ ] Satis Outreach agent raporunu oku
- [ ] Email agent raporunu oku

### Step 4b: Pipeline Metrikleri
- [ ] Lead sayisi ve donusum orani degerlendirme
- [ ] Deal pipeline durumu kontrol
- [ ] Funnel daralma noktalarini tespit et

### Step 4c: Segment Stratejisi
- [ ] Segment bazli performans analizi
- [ ] Strateji guncellemesi gereken segmentleri belirle
- [ ] Yeni segment firsatlarini degerlendirme

### Step 4d: Sicak Lead Bildirimi
- [ ] Yuksek potansiyelli lead varsa Onur'a bildir
- [ ] Acil aksiyon gerektiren firsatlari isaretle

### Step 5: Report
- [ ] Ust yoneticiye (CEO) rapor comment yaz
- [ ] Buyume metriklerini ve firsatlari ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
