# paperclip-dpo-service

Fastify-HTTP-Gate für die `paperclip-dpo`-Library. Läuft auf dem Mac Studio, erreichbar aus `192.168.2.0/24` unter Port 4711.

## Endpoints

| Method | Path | Auth | Zweck |
|---|---|---|---|
| GET | `/health` | — | Classifier-Status (10s cached) |
| POST | `/anonymize` | `X-DPO-Key` | Pseudonymisiert Text |
| POST | `/deanonymize` | `X-DPO-Key` | Stellt Klartext aus Pseudonymen wieder her |
| POST | `/safe-call` | `X-DPO-Key` | Kompletter Roundtrip (anon → extern → deanon) |

## Installation

```bash
# 1. Build
cd paperclip-dpo && pnpm install && pnpm build
cd ../paperclip-dpo-service && pnpm install && pnpm build

# 2. Shared Key generieren und in macOS-Keychain ablegen
SHARED_KEY=$(./scripts/generate-shared-key.sh)
security add-generic-password -s ai.whitestag.paperclip-dpo-key -a shared -w "$SHARED_KEY"

# 3. launchd installieren
sudo mkdir -p /var/paperclip/dpo /var/log/paperclip-dpo
sudo chown $USER /var/paperclip/dpo /var/log/paperclip-dpo
DPO_SHARED_KEY="$SHARED_KEY" ./scripts/install-launchd.sh

# 4. Smoke-Test
curl http://localhost:4711/health
```

## Env Vars

| Var | Default | Pflicht | Beschreibung |
|---|---|---|---|
| `DPO_SHARED_KEY` | — | ja | Shared Secret, min 32 Zeichen |
| `DPO_PORT` | `4711` | | HTTP-Port |
| `DPO_BIND` | `0.0.0.0` | | Listen-Interface |
| `DPO_MAPPING_DB` | — | ja | SQLite-Pfad |
| `DPO_AUDIT_DIR` | — | ja | JSONL-Log-Dir |
| `DPO_CLASSIFIER_URL` | `http://localhost:1234` | | LM Studio Endpoint |
| `DPO_CLASSIFIER_MODEL` | `gemma-4-26b` | | Classifier-Modell |
| `DPO_CLASSIFIER_TIMEOUT_MS` | `30000` | | Classifier-Timeout |
| `DPO_TELEGRAM_BOT_TOKEN` | — | | Alerts aktiv wenn gesetzt |
| `DPO_TELEGRAM_CHAT_ID` | — | | Chat für Alerts |

## Firewall (macOS)

macOS fragt beim ersten Start, ob `node` eingehende Verbindungen akzeptieren darf — zulassen. Oder manuell:
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(command -v node)"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(command -v node)"
```

## Klient-Verteilung

Andere Hosts (n8n-Host, Windows-CFO) brauchen den `DPO_SHARED_KEY`-Wert für ihren `X-DPO-Key`-Header. Übertragung via 1Password / Windows-Credential-Store / n8n-Credential.
