# Security Heartbeat

**Agent**: Security
**Interval**: 24 saat
**Scope**: Dependency audit, SAST taramasi, RLS dogrulama, bulgu siniflandirma

---

## Heartbeat Adimlari

### Step 1: Wake
- [ ] Kimlik dogrula (`GET /api/agents/me`)
- [ ] Agent ID ve rol teyit et

### Step 2: Context
- [ ] Wake context oku
- [ ] `SHARED-CONTEXT.md` referans al
- [ ] Guvenlik politikalarini ve threshold'lari oku

### Step 3: Inbox
- [ ] Atanan issue'lari listele
- [ ] Oncelik sirasina gore sirala

### Step 4a: Dependency Audit
- [ ] `npm audit` calistir (tum Node.js projeleri)
- [ ] `pip-audit` calistir (tum Python projeleri)
- [ ] Bilinen CVE'leri listele

### Step 4b: SAST Taramasi
- [ ] CodeQL taramasi calistir
- [ ] Semgrep taramasi calistir
- [ ] Statik analiz bulgularini topla

### Step 4c: RLS Policy Dogrulama
- [ ] Supabase RLS policy'lerini kontrol
- [ ] Her schema icin RLS aktif mi dogrula
- [ ] Acik kalan tablo/view tespit

### Step 4d: Bulgu Siniflandirma
- [ ] Bulgulari severity ile sinifla: CRITICAL / HIGH / MEDIUM / LOW
- [ ] CVSS skoru degerlendirmesi
- [ ] Etkilenen servisleri belirle

### Step 4e: Eskalasyon
- [ ] CRITICAL bulgu varsa CTO'ya acil issue olustur
- [ ] CRITICAL bulgu varsa Nail'e Telegram bildirim
- [ ] Remediation onerisi hazirla

### Step 5: Report
- [ ] Ust yoneticiye (CTO) rapor comment yaz
- [ ] Guvenlik durumunu ve bulgulari ozetle

### Step 6: Cleanup
- [ ] Stale issue kontrol
- [ ] Timeout'lari isle
- [ ] Tamamlanmis issue'lari kapat

### Step 7: Exit
- [ ] Heartbeat tamamla
- [ ] Sonraki heartbeat zamanini kaydet
