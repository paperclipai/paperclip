Konzept: Obsidian-Paperclip-Integration
1. Zielsetzung
Obsidian (lokales, Markdown-basiertes Wissensmanagement) soll mit Paperclip (agentengesteuerte Aufgaben- und Projektsteuerung) verbunden werden. Ziel ist ein nahtloser Informationsfluss zwischen persönlichem Wissensmanagement und teamweiter Aufgabensteuerung.

2. Daten und Synchronisationsrichtung
2.1 Welche Daten werden synchronisiert?
Datentyp	Obsidian-Repräsentation	Paperclip-Repräsentation	Richtung
Tasks/Issues	Markdown-Datei mit YAML-Frontmatter	Issue-Objekt via API	Bidirektional
Kommentare	Abschnitt in der Task-Datei oder verlinkte Notiz	Issue-Kommentare	Bidirektional
Plandokumente	Markdown-Datei im Vault	Issue-Dokument (key: plan)	Bidirektional
Projekte/Goals	Ordnerstruktur oder Index-Notiz mit Frontmatter	Project/Goal-Objekte	Paperclip → Obsidian (read-only)
Agenten-Info	Referenz-Notiz pro Agent	Agent-Objekte	Paperclip → Obsidian (read-only)
Persönliche Notizen	Beliebige Vault-Notizen	—	Kein Sync (bleiben lokal)
2.2 Sync-Richtungen im Detail
Bidirektional (Tasks): Status, Priorität, Titel, Beschreibung. Konfliktlösung: Last-Write-Wins mit Timestamp-Vergleich, optionaler manueller Merge.
Paperclip → Obsidian (Projekte, Goals, Agenten): Read-only Referenz-Notizen.
Obsidian → Paperclip (Kommentare): Neue Kommentare als Issue-Kommentare posten.
3. Technische Architektur
3.1 Empfohlener Ansatz: Obsidian Community Plugin + Paperclip REST API
┌─────────────────────┐         HTTPS/REST          ┌──────────────────┐
│   Obsidian Vault    │ ◄──────────────────────────► │  Paperclip API   │
│  ┌───────────────┐  │    Authorization: Bearer     │  /api/issues     │
│  │ Paperclip     │──┼──────────────────────────────┤  /api/comments   │
│  │ Plugin        │  │                              │  /api/projects   │
│  └───────────────┘  │                              │  /api/documents  │
│  📁 paperclip/      │                              └──────────────────┘
└─────────────────────┘
Begründung: Direkte Client-zu-API-Kommunikation, kein Middleware-Server nötig, ausgereiftes Plugin-Ökosystem (Todoist, Linear, Jira als Vorbilder).

3.2 Alternative Ansätze (evaluiert)
Ansatz	Bewertung
Filesystem-Sync (Vault = Workspace)	❌ Konfliktanfällig, kein Echtzeit-Feedback
API-Bridge / Middleware	⚠️ Für Phase 2 (Webhook-Support)
Paperclip Routines + Webhooks	⚠️ Ergänzend nutzbar, braucht trotzdem Plugin
3.3 Plugin-Kern-Module
SyncEngine — Pull/Push-Orchestrierung, Konfliktlösung, State-Tracking
PaperclipClient — HTTP-Wrapper (Auth, Error-Handling, Rate-Limiting)
VaultManager — Markdown-Dateien mit Frontmatter lesen/schreiben
ConflictResolver — Timestamp-basierte Last-Write-Wins-Logik
SettingsManager — API-URL, API-Key (SecretStorage), Company-ID, Sync-Intervall
4. Benötigte Paperclip-APIs
Endpunkt	Zweck
GET /api/agents/me	Identität beim Setup
GET /api/companies/:id/issues?assigneeAgentId=...	Issues laden
GET /api/issues/:id
Issue-Details
PATCH /api/issues/:id
Status/Titel updaten
POST /api/companies/:id/issues	Issues erstellen
GET/POST /api/issues/:id/comments
Kommentare lesen/schreiben
GET/PUT /api/issues/:id/documents/:key
Dokumente lesen/updaten
GET /api/companies/:id/projects	Projektliste
GET /api/companies/:id/goals	Goal-Hierarchie
GET /api/companies/:id/agents	Agentenliste
Authentifizierung: API-Key via SecretStorage (macOS Keychain / Windows Credential Manager / Linux libsecret).

Wünschenswerte API-Erweiterungen (Phase 2): Webhook/SSE für Echtzeit-Push, Delta-Polling (updatedSince), OAuth-Flow für Board-User.

5. Datenformat im Vault
Issue-Datei (Beispiel)
---
paperclip_id: "82729ae0-..."
paperclip_identifier: "WHI-19"
paperclip_status: "in_progress"
paperclip_priority: "medium"
paperclip_assignee: "CTO"
paperclip_project: "WHITESTAG AI Platform"
paperclip_synced_at: "2026-04-19T17:24:22Z"
tags: [paperclip]
---
# WHI-19: Konzept erstellen
Beschreibung...
Ordnerstruktur
paperclip/
  issues/WHI/WHI-17.md, WHI-19.md
  projects/WHITESTAG AI Platform.md
  agents/CTO.md, CEO.md
  _sync-state.json
6. Sicherheit und Datenschutz
Prinzip	Umsetzung
Datenminimierung	Nur zugewiesene/abonnierte Issues synchronisieren
Lokale Hoheit	Persönliche Notizen werden nie gesendet
Sichere Credentials	OS-Level SecretStorage, nie Plaintext
Verschlüsselung	Nur HTTPS
Transparenz	Sync-Log im Plugin-UI
Risiko-Mitigationen: SecretStorage gegen Key-Leak, explizites Opt-in gegen unbeabsichtigten Upload, Backup vor Überschreiben gegen Sync-Konflikte.

7. MVP-Scope
Phase 1: MVP
Plugin-Setup mit API-Key (SecretStorage)
Pull: Zugewiesene Issues als Markdown laden
Push: Status-Updates aus Obsidian (Frontmatter → PATCH)
Kommentare lesen und schreiben
Command: "Im Browser öffnen"
Manueller Sync + Intervall-Polling
Phase 2: Erweiterung
Bidirektionaler Full-Sync
Issue-Erstellung aus Obsidian
Projekt/Goal-Hierarchie als Ordner
Sidebar-View mit Filtern
Inline-Issue-Referenzen
Phase 3: Fortgeschritten
Echtzeit-Sync via Webhooks
Dashboard-View
Dataview-Integration
Attachment-Upload
Template-System
8. Nächste Schritte
Board-Entscheidung: MVP-Scope bestätigen
API-Erweiterung prüfen: Delta-Polling auf Paperclip-Seite
Plugin-Scaffolding: Obsidian Template mit TypeScript
Prototyp: Read-Only-Sync als Proof of Concept
Subtasks für Implementierung erstellen