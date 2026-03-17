# Security Audit Skill

Periyodik guvenlik auditi — dependency vulnerability, hardcoded secret, auth review, OWASP kontrolleri.

## Ne Zaman Calisir
- Manuel: `/security-audit` komutu ile
- Otomatik: 2 haftada bir (n8n cron trigger)

## Audit Adimlari

### 1. Dependency Vulnerability Scan
```bash
pnpm audit 2>&1
```
- HIGH+ vulnerability varsa: PR ac, dependency override ekle
- Rapor: vuln sayisi, etkilenen paketler, fix PR numarasi

### 2. Hardcoded Secret Taramasi
```bash
grep -rn "password\|secret\|api_key\|token\|credential" server/src/ packages/ --include="*.ts" \
  | grep -v "node_modules\|\.d\.ts\|test\|__tests__\|\.test\." \
  | grep -v "process\.env\|config\.\|options\.\|interface\|type\|import"
```
- env var referansi KABUL EDILIR
- Literal string degeri RAPORLANIR

### 3. Auth Middleware Review
- `server/src/middleware/auth.ts` oku
- Kontrol: companyId isolation, JWT validation, session resolve
- Yeni eklenen route'larda auth check var mi?

### 4. Rate Limiting Coverage
```bash
grep -rn "rateLimit\|rateLimiter\|sliding.*window\|quota" server/src/ --include="*.ts"
```
- Tum public API endpoint'lerinde rate limit var mi?
- Plugin endpoint'leri korunuyor mu?

### 5. OWASP Top 10 Checklist
| # | Kontrol | Nasil |
|---|---------|-------|
| A01 | Broken Access Control | Auth middleware + company scoping |
| A02 | Cryptographic Failures | JWT signing, key hashing |
| A03 | Injection | Drizzle ORM (parameterized), sanitizeEnvValue |
| A04 | Insecure Design | Atomic checkout, budget enforcement |
| A05 | Security Misconfiguration | .env template, deployment modes |
| A06 | Vulnerable Components | pnpm audit |
| A07 | Auth Failures | Session management, JWT TTL |
| A08 | Data Integrity | Activity log, run audit trail |
| A09 | Logging & Monitoring | Pino logger, activity events |
| A10 | SSRF | Private hostname guard middleware |

### 6. Rapor Olustur
Sonuclari Obsidian Vault'a yaz:
```
vault_write("Hafiza/guvenlik-audit/paperclip-YYYY-MM-DD.md", rapor)
```

## Rapor Formati
```markdown
# Guvenlik Audit — [Proje] ([Tarih])

## Ozet
- Toplam vuln: X (Y HIGH, Z MODERATE)
- Hardcoded secret: X bulundu
- Auth coverage: X/Y endpoint
- OWASP score: X/10

## Dependency Vulnerabilities
[pnpm audit ciktisi]

## Hardcoded Secrets
[Buluntular veya "0 bulundu"]

## Auth Review
[Degisiklikler ve notlar]

## OWASP Checklist
[10 item durum tablosu]

## Aksiyonlar
- [ ] [Acilan PR'lar]
- [ ] [Gerekli fix'ler]
```

## Proje Bazli Ek Kontroller
- **Paperclip:** Agent key scoping, cross-company isolation, budget enforcement
- **HukukBank:** Supabase RLS, schema isolation, public API rate limit
- **Navico:** Scraper credential rotation, VPS port exposure
- **Vepora/Emir:** Gumruk API key security, CORS configuration
