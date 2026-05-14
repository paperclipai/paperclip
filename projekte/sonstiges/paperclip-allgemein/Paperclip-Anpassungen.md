# Paperclip-Anpassungen (WHITESTAG)

Übersicht aller großen Anpassungen am Standard-Paperclip.

## 1. Custom Packages (neue Kernmodule)

- **paperclip-dpo/** — Datenschutzbeauftragter-Agent als Anonymisierungs-Proxy zwischen Paperclip-Agenten und externen LLMs. Regex-Detektoren (Email, IBAN, USt-IdNr.) + Gemma-Klassifikator, SQLite-AES-verschlüsseltes Audit-Log, Fail-Closed-Logik. DSGVO-konform (Art. 25, 32, 28, 30, 9).
- **paperclip-adapter-lmstudio/** — Adapter für lokale LLMs (LM Studio, OpenAI-kompatibel) mit 18 Tools (Paperclip-API, Dateisystem, Shell/Git). Primary/Fallback-Endpoints mit Health-Probes, Path-Traversal-Schutz, Runaway-Loop-Timeout.
- **paperclip-i18n/** — Gerüst für deutsche Lokalisierung (Translations noch leer).

## 2. Custom Skills (21 Stück, unter `skills/`)

### WHITESTAG-Domain
- `whitestag-brand` — Corporate Identity & Brand Guidelines
- `whitestag-n8n-workflow` — n8n Workflow-Editor & Debugger
- `whitestag-dsgvo` — DSGVO-Compliance-Prüfung
- `whitestag-angebot` — Angebotserstellung/Proposal-Generator

### VR / Kreativ
- `vr-produktion-pipeline` — End-to-End 360°-Filmproduktion
- `mistika-vr-pipeline` — Mistika VR Stitching & Postproduktion
- `drehbuch-vr` — VR-spezifisches Drehbuchschreiben
- `adobe-automation` — Adobe CC Scripting/Automation
- `blender-scripting` — Blender Python Scripting & Add-ons

### Finanzen
- `buchhaltung-euer` — Unternehmenssteuer-Management
- `buchhaltung-einkommensteuer` — Einkommenssteuer-Berechnung
- `vermoegen-overview`, `vermoegen-aktien`, `vermoegen-etf`, `vermoegen-gold` — Vermögensmanagement-Suite

### Recherche / Memory
- `online-recherche` — strukturierte Web-Recherche
- `para-memory-files` — PARA-Methode (Tiago Forte) für Wissensmanagement

### Standard-Paperclip (behalten)
- `paperclip`, `paperclip-create-agent`, `paperclip-create-plugin`

## 3. Custom Agenten

- **server/whitestag-agenten.md** — CEO, CTO, CPO, CMO, CRO, CFO, Creative Director mit modellspezifischer LLM-Zuordnung (qwen3.6-35b-a3b, qwen2.5-32b, gemma-4-26b).
- **CFO auf Windows-Host** (`http://192.168.2.181:1234`) für DSGVO-Kritikalität.
- LLM-Wahl pro Agent dokumentiert mit Rationale (Reasoning-Anforderungen, Deutsch-Tonalität, lokale Sicherheit).

## 4. Voice / Telegram / n8n-Integration

- **Luna Voice + Telegram V10.json** — Audio-Input-Pipeline, Voice-to-Text, PostgreSQL-Sync (`tg_chat_users`, `tg_messages`).
- **Paperclip CEO - Voice & Telegram V1/V2/V3.json** — CEO-Agent-Bridge, 3 Iterationen (~130 KB JSON).
- Git-Commits: Design Spec (`34a23fe0`), Implementation Plan (`7bbc057b`).

## 5. Dokumentation

- `Paperclip-Anleitung.md` — Nutzungshandbuch (Issue-Management, Heartbeats, Agent-Konfiguration)
- `LLM-Empfehlungen Paperclip-Agenten.md` — Detaillierte Modell-Zuordnung pro Agent
- `DSGVO Agent.md` — DPO-Agent-Spezifikation (Kernarchitektur, NER-Pipeline, DSGVO-Artikel-Mapping)
- `Obsidian-Paperclip-Integration.md` — Design für Obsidian-Vault-Sync
- `Angebotsvorlagen/` — WHITESTAG.AI und WHITESTAG.FILM Angebotsmuster

## 6. Core-Modifikationen

Keine destruktiven Core-Änderungen — alle Erweiterungen sind additive Packages/Plugins/Skills im Plugin-Pattern.

## 7. Organisatorische Änderungen

- **Lokale Datenbank-Integration:** n8n verbindet Telegram-Nachrichten mit PostgreSQL.
- **Multi-Host-Setup:** CEO auf Mac, CFO auf Windows — Load-Balancing über Health-Probes.
- **Company-Scoping:** WHITESTAG-Company-ID `9cebf3cf-efe8-4597-a400-f06488900a87`, Prefix `WHI`.

---

## Die drei größten Anpassungen

1. **DPO-Agent (`paperclip-dpo`)** — Vollständige DSGVO-Compliance-Infrastruktur mit PII-Erkennung, Pseudonymisierung, Audit-Logging, Fail-Closed-Semantik. ~36 Commits, ~2000 LoC.
2. **LM-Studio-Adapter (`paperclip-adapter-lmstudio`)** — 100% lokale Agentenautonomie mit Tool-Use über qwen/gemma/mistral. Primary/Fallback, Health-Probing, Runaway-Loop-Prevention. 20+ Commits, ~3000 LoC.
3. **Voice + Telegram-Integration** — Produktive Voice-to-Text + Chat-Management-Pipeline via n8n (~130 KB JSON) + PostgreSQL-Schema, 3 Workflow-Versionen.
