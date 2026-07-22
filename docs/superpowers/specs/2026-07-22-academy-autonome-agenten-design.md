# Design: Autonome Agenten-Weiterentwicklung für WHITESTAG.ACADEMY

**Datum:** 2026-07-22
**Status:** Design (genehmigt, Spec zur Review)
**Ziel:** Software-Agenten entwickeln die WHITESTAG.ACADEMY-App (Expo/React
Native + Supabase) eigenständig weiter, mit einem harten Sicherheitsnetz und
täglichem Reporting an Walter.

## Kontext

WHITESTAG.ACADEMY liegt unter
`~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/WHITESTAG.ACADEMY`
und ist ein echtes Produkt: Expo/React Native (iOS + Android), Supabase-Backend,
TypeScript, Jest-Tests, eigenes Git-Repo, `AGENTS.md`, `CD-CI/`-Ordner.

Bereits vorhanden: ein Workshop-Agent, der täglich **Inhalte** generiert
(Paperclip-Routine, siehe `project_academy_workshop_routine`). Neu ist der
Wunsch, dass Agenten den **App-Code selbst** weiterentwickeln.

Grundproblem: Paperclip-Agenten (lokale LM-Studio-Modelle) haben per MCP nur
Koordinations-/Wissens-Tools — **kein** `fs_write`, keine Shell, kein Git.
Sie können denken, planen, Specs/Deliverables schreiben und über APIs handeln,
aber nicht eigenmächtig in ein Repo committen oder Prozesse neustarten. Dieses
Design baut die kontrollierte Brücke von „denken" zu „ausführen".

## Entscheidungen (aus dem Brainstorming)

| Frage | Entscheidung |
|---|---|
| Kontroll-Gate / Autonomie | Mittel-hoch: Tests-grün + Reporting statt Freigabe je Änderung; `master`/Release bleibt manuell |
| Code-Engine | **Hybrid**: lokale Agenten triagieren/planen, Claude Code implementiert das Substanzielle |
| Arbeitsquelle | **Voll selbstgesteuert**: Agenten finden TODOs/Bugs/Test-Lücken selbst |
| Reporting | **Täglicher Jarvis/Telegram-Digest** + Sofort-Ping bei rotem Build/Blocker |
| Architektur | **① Orchestrator + headless Claude Code im Git-Worktree** (auf Mac Studio) |

Verworfene Alternativen: ② Paperclip-Execution-Workspace (auf Runtime-Services
ausgelegt, für echte RN/Expo-Entwicklung unerprobt, hoher Integrationsaufwand);
③ lokale Agenten direkt mit Git/Shell (schwache Coder direkt an echter App →
hohes Risiko kaputter Builds).

## Architektur — der tägliche Loop

Alles läuft auf dem **Mac Studio** (24/7-Anker) als vertrauenswürdiger
Ausführungskontext. `launchd`-Trigger, analog zu Workshop-Routine und
n8n-Watcher.

```
launchd (täglich, z.B. 02:00)
        │
        ▼
Phase 0 — Setup
  • frischen Git-Worktree von Academy anlegen (Branch: agents/academy-auto)
  • Pause-Flag prüfen → wenn gesetzt: sofort raus
Phase 1 — Triage (lokaler „Academy Tech Lead")
  • Repo-Survey: offene TODOs, failing tests, Test-Lücken, Lint-Warnungen
  • priorisierte Task-Liste (max N pro Lauf)
  • als Paperclip-Issues abgelegt (idempotent)
Phase 2 — Implementierung (headless Claude Code)
  • pro Task: TDD → implementieren → Tests
  • Commit auf den Worktree-Branch
  • Diff-/Scope-Caps beachten
Phase 3 — Grünes Gate
  • jest + tsc + lint + Expo-Prebuild-Sanity
  • grün → PR öffnen (bzw. Merge auf dev)
  • rot → verwerfen, Sofort-Ping, Task pausieren
Phase 4 — Reporting
  • Jarvis/Telegram-Digest
```

**Kernprinzip:** Die schwachen lokalen Modelle machen **nur die Triage**
(lesen/priorisieren). Das **eigentliche Code-Schreiben macht Claude Code**
(headless, voller Edit/Test/Git-Toolchain) im **isolierten Worktree** — nie in
Walters Arbeitskopie.

## Komponenten

1. **Orchestrator-Skript** (`~/.paperclip/scripts/academy-auto/`, wegen
   launchd-CloudStorage-Sperre nicht im SynologyDrive) — steuert die Phasen,
   legt Worktree an, ruft Claude Code headless auf, führt das Gate aus, sendet
   den Digest. Idempotent, mit Lockfile (flock).
2. **Triage-Einheit** — lokaler „Academy Tech Lead"-Agent (oder günstiger
   Claude-Pass), erzeugt priorisierte Task-Liste als Paperclip-Issues.
3. **Implementierungs-Einheit** — headless Claude Code im Worktree, ein Task
   nach dem anderen, TDD.
4. **Green-Gate-Einheit** — führt `jest`, `tsc --noEmit`, Lint und
   Expo-Prebuild-Sanity aus; Ergebnis entscheidet PR vs. Verwerfen.
5. **Reporting-Einheit** — Digest-Bau + Versand über `voice-echo-bot`
   (@whitestag_jarvis_bot).

Jede Einheit hat genau einen Zweck, kommuniziert über klar definierte Ein-/
Ausgaben (Task-Liste als Issues, Branch/Commit als Artefakt, Gate-Ergebnis als
Statusobjekt) und ist einzeln testbar.

## Sicherheitsnetz (acht Schichten)

1. **Isolation** — Arbeit ausschließlich im dedizierten Git-Worktree/Branch
   (`agents/academy-auto`). `master` und Walters offene Arbeitskopie werden nie
   angefasst.
2. **Scope-Zaun** — Pfad-Allowlist: nur das Academy-Repo. Kein Zugriff auf
   andere Projekte, keine `.env`/Secrets, keine Supabase-Prod-Migrationen ohne
   Extra-Freigabe-Label.
3. **Grünes Gate** — kein PR/Merge ohne grünes `jest` + sauberes `tsc` + Lint +
   Expo-Prebuild-Check.
4. **Integrations-Gate** — grün → PR (oder Auto-Merge nur auf `dev`).
   `master`/Store-Release bleibt hinter Walters manuellem Merge. Das ist die
   „mittel-hohe" Autonomiegrenze.
5. **Deploy ist tabu** — App-Store/EAS-Submission ausdrücklich außerhalb des
   Loops.
6. **Caps** — max. N Tasks/Lauf, max. Diff-Größe/Task, keine Dependency-/
   Lockfile-Umbauten und keine destruktiven Migrationen ohne Freigabe.
7. **Kill-Switch** — Flag-File (`~/.paperclip/academy-auto.pause`) oder
   Paperclip-Label hält den Loop sofort an.
8. **Audit** — jeder Lauf geloggt, jede Änderung ist ein prüfbarer Commit/PR.
   Nichts passiert unsichtbar.

## Reporting

Täglicher **Jarvis/Telegram-Digest** am Laufende: *was gebaut wurde · offene
PRs/Branches · Test-Status · was als Nächstes geplant ist.* Plus **Sofort-Ping**
bei rotem Build oder Blocker. Kanal: bestehender `voice-echo-bot`.

## Fehlerbehandlung

- **Rotes Gate:** Task-Commits verwerfen (Worktree zurücksetzen), Task in
  Paperclip als `blocked` markieren, Sofort-Ping, mit nächstem Task fortfahren.
- **Claude-Code-Fehler/Timeout:** Lauf sauber beenden, Teil-Ergebnisse (grüne
  Tasks) behalten, im Digest vermerken.
- **Worktree-Konflikt / dirty state:** Worktree neu aufsetzen; nie in einen
  unsauberen Baum schreiben.
- **Pause-Flag mitten im Lauf:** aktuellen Task zu Ende führen, dann anhalten.

## Testing

- Orchestrator-Logik (Phasenübergänge, Gate-Auswertung, Cap-Prüfung, Pause-Flag)
  mit Unit-Tests, LM-/Claude-/Git-Aufrufe gemockt.
- Green-Gate gegen einen bewusst roten und einen grünen Fixture-Commit
  verifizieren.
- Digest-Bau gegen ein Beispiel-Laufergebnis (Snapshot).
- Isolation: Test, dass ein Lauf `master` und die Haupt-Arbeitskopie nicht
  verändert.

## Phasing (YAGNI)

- **Phase A (MVP):** Orchestrator + Worktree-Isolation + Green-Gate +
  Claude-Code-Implementierung für **eine** Task/Lauf + Jarvis-Digest.
  Triage zunächst von Hand angestoßen, um den Loop sicher einzufahren.
- **Phase B:** Selbstgesteuerte Triage (lokaler Tech-Lead-Agent) + mehrere
  Tasks/Lauf + Kill-Switch + launchd-Automatik.
- **Phase C:** Feinschliff — Caps-Tuning, PR-Auto-Merge auf `dev`,
  Blocker-Eskalation.

## Offene Punkte für die Umsetzung

- Genaue Test-/Lint-/Prebuild-Kommandos aus Academy `package.json` +
  `CD-CI/` verifizieren (Green-Gate muss die echten Skripte treffen).
- Existierenden CI-Stand prüfen — falls GitHub Actions o.ä. vorhanden, Gate
  daran ausrichten statt doppeln.
- Headless-Claude-Code-Aufrufform festlegen (CLI-Flags, Modell, Effort-Budget).
- Wert für N (Tasks/Lauf) und Diff-Cap festlegen.
