# DPO-Policy

**Stand:** 2026-04-21
**Review-Kadenz:** vierteljährlich (nächster Review: 2026-07-21)
**DSB:** Walter Schönenbröcher (de-facto, formale Benennung nicht erforderlich bei <10 MA und keiner systematischen Art-9-Verarbeitung nach §38 BDSG)

## Abgedeckt durch DPO-Gate

Alle Aufrufe auf dieser Liste müssen durch den DPO-Service laufen (technisch erzwungen):

| Pfad | Deckung | Durchsetzung |
|---|---|---|
| n8n-Workflows → OpenAI/Anthropic direkt | ✅ Pflicht | Sub-Workflow `DPO-Proxy V1`; direkte OpenAI-Nodes in Produktions-Workflows sind unzulässig |
| TS-Code → Anthropic/OpenAI direkt | ✅ Pflicht | Über `createDpoClient()` aus `paperclip-dpo` |

## Nicht abgedeckt (bewusst)

Diese Systeme rufen externe LLMs auf, können aber technisch nicht transparent gegated werden. Kontrolle erfolgt organisatorisch:

| Adapter | Grund | Mitigation |
|---|---|---|
| `claude-local` | Agentisches CLI mit Filesystem-Zugriff; die CLI ruft Anthropic selbst auf, nach dem Prompt-Hand-off ist der Adapter blind für weiteren Traffic | Keine Kundendaten in Dateien, die von diesen Agenten referenziert werden. Für PII-haltige Aufgaben lokale LLMs (LM Studio) nutzen |
| `codex-local` | Analog | Analog |
| `cursor-local` | Analog | Analog |
| `gemini-local` | Analog | Analog |
| `opencode-local` | Analog | Analog |
| `openclaw-gateway` | Routing zum Paperclip-Gateway (extern betrieben) | Auftragsverarbeitungsvertrag mit Gateway-Betreiber als Kontroll-Pfad |

## Vertrauenswürdige lokale LLMs (kein DPO nötig)

Daten verlassen den LAN-Perimeter nicht:

| Host | Endpoint | Einsatz |
|---|---|---|
| Mac Studio | `http://localhost:1234`, `http://192.168.2.10:1234` (je nach Konfiguration) | CEO, CTO, CPO, CMO, CRO, Creative Director — lokale LLM-Aufrufe via LM Studio |
| Windows-CFO-Host | `http://192.168.2.181:1234` | CFO (DSGVO-kritische Finanzdaten) |

## Regel für Agenten-Konfiguration

- **Cloud-LLMs (Claude/OpenAI/Gemini):** nur für PII-freie oder bereits anonymisierte Aufgaben, oder im CLI-Modus ohne Dokument-Referenzen.
- **Lokale LLMs:** Default für alles mit Kundendaten-Berührung.
- Neue Agenten-Adapter müssen im Review vor Produktionseinsatz gegen diese Liste geprüft werden.

## Review-Checkliste (vierteljährlich)

- [ ] Sind neue Adapter hinzugekommen? In Tabelle oben einsortieren.
- [ ] Sind neue n8n-Workflows hinzugekommen, die extern rausrufen? Über `DPO-Proxy V1` geroutet?
- [ ] Gab es Art-9-Alerts im letzten Quartal? Ursache dokumentieren.
- [ ] Telegram-Alerts im letzten Quartal gezählt und nach Typ klassifiziert.
- [ ] Audit-Log-Verzeichnis (`/var/paperclip/dpo/audit/`) noch schreibbar und nicht voll.
- [ ] `DPO_SHARED_KEY` älter als 12 Monate? Rotation planen.

## Eskalationspfad bei Verstoß

1. Verstoß bemerkt (z.B. direkter OpenAI-Call in neuem Workflow) → sofort in Paperclip-Issue dokumentieren, betroffener Call deaktivieren.
2. Prüfung, ob Daten bereits übertragen wurden (Audit-Log-Abgleich).
3. Ggf. Meldung nach Art. 33 DSGVO an zuständige Aufsichtsbehörde (Brandenburg: LDA Brandenburg) binnen 72h, wenn Risiko für Betroffene besteht.

## DSGVO-Artikel-Mapping

| Artikel | Umsetzung |
|---|---|
| Art. 25 (Privacy by Design) | DPO-Gate als technische Vorkehrung |
| Art. 32 (Pseudonymisierung) | AES-verschlüsselte Mapping-DB |
| Art. 28 (Auftragsverarbeitung) | Audit-Log dokumentiert Empfänger |
| Art. 30 (Verarbeitungsverzeichnis) | Audit-Log als Datenbasis (formaler Generator = Follow-up) |
| Art. 9 (Besondere Kategorien) | Veto-Modus + Telegram-Alert |
