Konzept: Datenschutzbeauftragter-Agent (DPO-Agent)
Zusammenfassung
Ein lokaler LLM-Agent, der als Datenschutz-Proxy zwischen Paperclip-Agenten und öffentlichen LLMs (Claude, OpenAI) arbeitet. Er erkennt und anonymisiert personenbezogene und unternehmensspezifische Daten, bevor Anfragen an externe APIs gesendet werden — und de-anonymisiert die Antworten wieder.

Strategischer Kontext
Passt direkt zum WHITESTAG.AI-Ziel: lokale, datensouveräne KI-Lösungen für KMU
DSGVO-Konformität ist ein USP gegenüber Wettbewerbern, die nur Cloud-LLMs einsetzen
Ermöglicht Kunden den Einsatz öffentlicher LLMs ohne Datenschutzrisiko
Differenziert WHITESTAG.AI als datenschutzbewussten KI-Partner
Architektur-Überblick
[Paperclip Agent] → [DPO-Agent (lokal)] → [Public LLM API]
                         ↓                        ↓
                   PII-Erkennung            Antwort mit
                   Anonymisierung           Pseudonymen
                   Mapping-Tabelle              ↓
                         ↓               [DPO-Agent (lokal)]
                   Pseudonymisierte            ↓
                   Anfrage senden        De-Anonymisierung
                                         Antwort zurück an
                                         Paperclip Agent
Kernkomponenten
PII-Detektor (NER) — Lokales LLM oder spezialisiertes NER-Modell erkennt:

Personennamen
Firmennamen und Handelsregister-Nummern
Adressen, Telefonnummern, E-Mail-Adressen
Bankverbindungen (IBAN, BIC)
Steuernummern, USt-IdNr.
Vertragsnummern, Kundennummern
Sensible Geschäftsdaten (Umsätze, Gehälter, Preise)
Anonymisierungs-Engine — Ersetzt erkannte Entitäten durch konsistente Pseudonyme:

Max Mustermann → [PERSON_A]
WHITESTAG GmbH → [FIRMA_1]
Cottbus → [STADT_X]
Konsistente Zuordnung innerhalb einer Session (gleicher Name = gleiches Pseudonym)
Mapping-Tabelle (lokal) — Speichert die Zuordnung Klartext ↔ Pseudonym:

Verschlüsselt auf lokalem Storage
TTL-basiert (automatische Löschung nach konfigurierbarer Zeit)
Nie an externe APIs übermittelt
De-Anonymisierungs-Engine — Ersetzt Pseudonyme in LLM-Antworten zurück:

[PERSON_A] → Max Mustermann
Erkennt auch kontextuelle Referenzen
Audit-Log — Protokolliert:

Welche Daten anonymisiert wurden (Kategorie, nicht Inhalt)
Wann und für welchen Agent
Welches externe LLM angefragt wurde
Regelwerk (konfigurierbar pro Kunde/Projekt):

Welche Datenkategorien anonymisiert werden
Welche Daten durchgelassen werden dürfen (z.B. öffentliche Firmennamen)
Schwellenwerte für Confidence-Scores
Integration in Paperclip
Option A: Middleware-Agent (empfohlen)
Der DPO-Agent wird als Paperclip-Agent mit eigenem Adapter eingebunden:

Adapter-Typ: local_llm (z.B. Ollama, LM Studio, vLLM)
Modell: spezialisiertes NER-Modell oder allgemeines lokales LLM (z.B. Llama 3, Mistral, Qwen)
Wird von anderen Agenten über Paperclip-Subtasks aufgerufen
Oder: als transparenter Proxy im Request-Path
Option B: Adapter-Level Proxy
Einbau direkt in den Paperclip-Adapter-Layer
Jeder ausgehende API-Call an Claude/OpenAI wird automatisch durch den DPO-Filter geleitet
Vorteil: transparent, kein Agent-Wissen nötig
Nachteil: höhere Komplexität im Adapter-Code
Empfehlung: Option A als MVP
Option A ist einfacher umzusetzen, testbar und passt in die bestehende Paperclip-Architektur. Option B kann als Weiterentwicklung folgen.

Lokales LLM — Anforderungen
Modell: NER-optimiert oder allgemein fähig (Llama 3.1 8B, Qwen 2.5 7B, oder spezialisiertes deutsches NER-Modell)
Hardware: Läuft auf dem gleichen Server wie Paperclip (Mac Studio, lokaler Server)
Latenz: < 2 Sekunden für Anonymisierung eines durchschnittlichen Prompts
Sprache: Muss Deutsch und Englisch beherrschen
DSGVO-Relevanz
Art. 25 DSGVO: Datenschutz durch Technikgestaltung (Privacy by Design)
Art. 32 DSGVO: Pseudonymisierung als Sicherheitsmaßnahme
Art. 28 DSGVO: Auftragsverarbeitung — der DPO-Agent dokumentiert, was an Dritte geht
Verarbeitungsverzeichnis wird automatisch durch Audit-Log unterstützt
Umsetzungsplan
Phase 1: MVP (Proof of Concept)
 Lokales NER-Modell evaluieren und auswählen
 Basis-Anonymisierungs-Engine (Personen, Firmen, Adressen)
 Mapping-Tabelle mit Session-Scope
 Einfache De-Anonymisierung
 Integration als Paperclip-Agent
 Test mit einem bestehenden Workflow
Phase 2: Produktionsreife
 Erweitertes Regelwerk (pro Kunde konfigurierbar)
 Verschlüsselte Mapping-Tabelle mit TTL
 Audit-Logging
 Performance-Optimierung
 DSGVO-Dokumentation (DSFA, Verarbeitungsverzeichnis)
Phase 3: Skalierung
 Adapter-Level Integration (Option B)
 Multi-Tenant-Fähigkeit
 Dashboard für Datenschutz-Übersicht
 Kundenspezifische Anonymisierungsprofile
Offene Fragen (Board-Entscheidung)
Modellwahl: Spezialisiertes NER-Modell vs. allgemeines lokales LLM? (Trade-off: Genauigkeit vs. Flexibilität)
Granularität: Sollen auch semantisch sensible Daten erkannt werden (z.B. "unser größter Kunde hat letztes Jahr 2 Mio Umsatz gemacht")?
Performance-Budget: Akzeptable Latenz pro Request durch die Anonymisierung?
Scope: Nur für Paperclip-interne Agenten oder auch als eigenständiges Produkt für Kunden?